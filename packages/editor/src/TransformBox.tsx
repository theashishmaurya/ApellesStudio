/**
 * @apelles/editor — ONE draggable transform box: the rectangle, its four corner
 * handles, and the pointer wiring that turns a gesture into a committed
 * framing. Extracted from `TransformOverlay.tsx` by D-234.
 *
 * **Why it exists.** Dynamic zoom (D-234) draws TWO of these — a start box and
 * an end box — over the same picture, with the same drag behaviour the single
 * transform box has always had. Copy-pasting ~120 lines of pointer handlers
 * and handle JSX into a second overlay is exactly what this repo's "if two
 * places need it, extract it" rule forbids, and it is also how the two would
 * drift: a fix to the pointer-capture handling, the Escape cancel, or the
 * handle hit-slop would land in one and not the other. So the box is one
 * component with two consumers:
 *
 * - `TransformOverlay.tsx` — one box, committing through `set_clip_transform`
 *   / `set_clip_keyframes` per D-209's per-property auto-key rule;
 * - `DynamicZoomOverlay.tsx` — two boxes, both committing through
 *   `dynamicZoom.ts`'s bake.
 *
 * **What it is NOT.** It knows nothing about clips, ops, keyframes, the store,
 * or where its geometry came from. It is handed a framing and a footprint, it
 * reports a new framing on release, and that is the whole contract — every
 * decision about what a released gesture MEANS belongs to the consumer. The
 * geometry math itself is still `transformGeometry.ts` (pure, unit-tested);
 * this file remains DOM/pointer wiring around it and is covered by the DOM
 * tests of the overlays that use it, matching the split that file's own doc
 * describes.
 *
 * **Live overlay-only feedback during a drag; ONE commit on pointer-up.** The
 * whole reason this pattern exists (D-136/Phase 0b, mirroring
 * `RelightPuckLayer.tsx`/D-046): `applyOp` pushes a whole-timeline undo
 * snapshot per call, so a naive `onPointerMove -> applyOp` would flood the undo
 * stack. Intermediate values live in `draft` and are never written anywhere.
 */
import { useEffect, useRef, useState } from 'react';

import {
  boxToScreenRect,
  clipBoxFraction,
  dragCornerScale,
  dragReposition,
  screenToFraction,
  type ContentBoxLike,
} from './transformGeometry';

/** Screen-pixel handle size + hit-slop, and the box stroke width — named
 *  constants per the house no-magic-numbers rule, not tuned against
 *  anything deeper than "comfortable to grab with a mouse." */
const HANDLE_SIZE = 10;
const HANDLE_HIT_SLOP = 6;
const BOX_STROKE_WIDTH = 1.5;

type Corner = 'nw' | 'ne' | 'sw' | 'se';
const CORNERS: Corner[] = ['nw', 'ne', 'sw', 'se'];

/** In-flight gesture state — local, uncommitted. `null` when no drag is
 *  active. */
type DragState =
  | { kind: 'move'; startPoint: { x: number; y: number }; startPosition: { x: number; y: number } }
  | { kind: 'scale'; startPoint: { x: number; y: number }; center: { x: number; y: number }; startScale: number };

/** The box's live, uncommitted geometry mid-drag — what it RENDERS from while
 *  a gesture is in flight, and the exact value the consumer is handed on
 *  release. */
export interface TransformDraft {
  position: { x: number; y: number };
  scale: number;
}

export type TransformGestureKind = 'move' | 'scale';

export function TransformBox({
  container,
  contentBox,
  position,
  scale,
  natural,
  restSize,
  moveEnabled,
  scaleEnabled,
  strokeClassName,
  dashed = false,
  label,
  onCommit,
}: {
  /** The element every pointer coordinate is measured against — the same one
   *  `contentBox` was measured against. */
  container: HTMLElement | null;
  contentBox: ContentBoxLike;
  /** The box's COMMITTED framing (composition fractions). */
  position: { x: number; y: number };
  scale: number;
  /** The clip's unscaled footprint in composition fractions — what a drag's
   *  `natural * scale` box math is built on. */
  natural: { width: number; height: number };
  /** The box's size AT REST, when it differs from `natural * scale` — D-193's
   *  independent `box_width`/`box_height` override, already resolved by the
   *  consumer. `null` (the common case) means "use `natural * scale`". A drag
   *  always falls back to the uniform formula regardless, which is what makes
   *  an on-canvas resize a deliberately simpler gesture than the Inspector's
   *  (see `TransformOverlay`'s own doc). */
  restSize: { width: number; height: number } | null;
  moveEnabled: boolean;
  scaleEnabled: boolean;
  /** Tailwind border-colour class for the stroke and handles — the ONE thing
   *  that distinguishes the boxes visually. Passed in rather than derived so
   *  every colour stays a token from the one source (`--color-*`), chosen by
   *  the consumer that knows what the box means. */
  strokeClassName: string;
  /** Dashed stroke — used by dynamic zoom's END box so both boxes stay legible
   *  when they sit exactly on top of each other (the correct "nothing authored
   *  yet" state), where two solid strokes would read as one box. */
  dashed?: boolean;
  /** A short caption pinned above the box's top-left corner (dynamic zoom's
   *  "Start"/"End"). Omitted for the plain transform box, which needs no
   *  label because there is only one of it. */
  label?: string;
  onCommit: (next: TransformDraft, kind: TransformGestureKind) => void;
}) {
  // **`draftRef` mirrors `draft` so pointer-up can READ the last dragged value
  // without a state updater** (D-209). Committing from inside a
  // `setDraft(current => …)` reads the right value but runs the consumer's
  // store write during React's own update computation — React logs "Cannot
  // update a component while rendering a different component" for exactly
  // that, and under StrictMode an updater may be invoked twice, which would
  // commit the gesture and push its undo entry TWICE. On an animated clip a
  // doubled commit means two keyframe writes, not one idempotent static write.
  const dragRef = useRef<DragState | null>(null);
  const draftRef = useRef<TransformDraft | null>(null);
  const [draft, setDraftState] = useState<TransformDraft | null>(null);
  const setDraft = (next: TransformDraft | null) => {
    draftRef.current = next;
    setDraftState(next);
  };

  const livePosition = draft?.position ?? position;
  const liveScale = draft?.scale ?? scale;

  // D-201 — no `useCallback` on any handler here, deliberately. The React
  // Compiler (D-091) auto-memoizes the whole component, but only when it can
  // *preserve* every piece of hand-written memoization; the ones this code
  // used to carry made it bail out of the file entirely, which costs the
  // highest-update-frequency surface in the Edit tab's preview every bit of
  // auto-memoization it would otherwise get. `reactCompiler.test.ts` fails if
  // a future edit reintroduces a bailout here.
  const localPoint = (e: { clientX: number; clientY: number }) => {
    if (!container) return { x: 0, y: 0 };
    const rect = container.getBoundingClientRect();
    return screenToFraction({ x: e.clientX - rect.left, y: e.clientY - rect.top }, contentBox);
  };

  const cancelDrag = () => {
    dragRef.current = null;
    setDraft(null);
  };

  // Escape cancels the in-flight gesture — listened for only while a drag is
  // actually active.
  useEffect(() => {
    if (!draft) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancelDrag();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [draft, cancelDrag]);

  const handleBodyPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !moveEnabled) return;
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { kind: 'move', startPoint: localPoint(e), startPosition: position };
    setDraft({ position, scale });
  };

  const handleCornerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !scaleEnabled) return;
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    // The box's own centre is the only pivot a single `scale` field can
    // express — see `dragCornerScale`'s own doc. Every corner therefore drives
    // the same uniform math (Phase 1, unchanged since D-136).
    const center = { x: 0.5 + position.x, y: 0.5 + position.y };
    dragRef.current = { kind: 'scale', startPoint: localPoint(e), center, startScale: scale };
    setDraft({ position, scale });
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    e.stopPropagation();
    const point = localPoint(e);
    if (drag.kind === 'move') {
      setDraft({ position: dragReposition(drag.startPoint, point, drag.startPosition), scale });
    } else {
      setDraft({ position, scale: dragCornerScale(drag.center, drag.startPoint, point, drag.startScale) });
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    e.stopPropagation();
    dragRef.current = null;
    // Read the live draft rather than recomputing — it's already exactly what
    // was last rendered, and pointerup itself can land a fraction of a pixel
    // from the last pointermove. Through the REF, not a `setDraft` updater —
    // see `draftRef`'s own note above for what that cost.
    const current = draftRef.current;
    setDraft(null);
    if (current) onCommit(current, drag.kind);
  };

  // While a drag is live the box always follows the uniform `natural * scale`
  // formula; at rest an independent size override takes over (D-193). Passing
  // the already-resolved size through as `natural` with `scale: 1` reuses
  // `clipBoxFraction` unchanged rather than needing a second box-math variant.
  const box =
    draft || !restSize
      ? clipBoxFraction(natural, livePosition, liveScale)
      : clipBoxFraction(restSize, livePosition, 1);
  const rect = boxToScreenRect(box, contentBox);

  return (
    <div
      className={`absolute ${strokeClassName}`}
      style={{
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        borderWidth: BOX_STROKE_WIDTH,
        borderStyle: dashed ? 'dashed' : 'solid',
        boxSizing: 'border-box',
      }}
      data-transform-box
    >
      {label && (
        <span
          className="text-text-primary bg-bg-primary/80 pointer-events-none absolute -top-5 left-0 rounded-sm px-1 text-[10px] leading-4"
          data-transform-box-label
        >
          {label}
        </span>
      )}
      {/* Body — reposition. Fully covers the box so a grab anywhere on the
          clip (not just its exact edge) starts a move, matching Premiere/
          Resolve's own "drag the picture" body affordance. */}
      <div
        className={moveEnabled ? 'absolute inset-0 pointer-events-auto cursor-move' : 'absolute inset-0'}
        onPointerDown={handleBodyPointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      />
      {scaleEnabled &&
        CORNERS.map((corner) => {
          const isTop = corner[0] === 'n';
          const isLeft = corner[1] === 'w';
          // The pointer TARGET is `HANDLE_HIT_SLOP` bigger on every side than
          // the VISIBLE handle — grabbing a corner shouldn't need pixel
          // accuracy. Outer div is the (invisible) hit area, centred on the
          // corner; inner div is the drawn square, centred inside it via flex.
          const hit = HANDLE_SIZE + HANDLE_HIT_SLOP * 2;
          return (
            <div
              key={corner}
              // D-204 — marks this as a real corner-grab target, so canvas
              // click-to-select never steals a resize gesture (a handle's hit
              // area deliberately overhangs the box by `HANDLE_HIT_SLOP` and
              // so can sit over another clip's picture). Same
              // `closest()`-on-a-marker convention `TimelinePane`'s D-100
              // clear-selection branch uses.
              data-transform-handle
              className="absolute pointer-events-auto flex items-center justify-center"
              style={{
                width: hit,
                height: hit,
                left: isLeft ? -hit / 2 : undefined,
                right: isLeft ? undefined : -hit / 2,
                top: isTop ? -hit / 2 : undefined,
                bottom: isTop ? undefined : -hit / 2,
                cursor: isTop === isLeft ? 'nwse-resize' : 'nesw-resize',
              }}
              onPointerDown={handleCornerPointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
            >
              <div
                className={`rounded-sm border bg-bg-primary ${strokeClassName}`}
                style={{ width: HANDLE_SIZE, height: HANDLE_SIZE }}
              />
            </div>
          );
        })}
    </div>
  );
}
