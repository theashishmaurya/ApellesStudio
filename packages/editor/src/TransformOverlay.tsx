/**
 * @chroma/editor — on-canvas transform handles for the Edit-tab preview
 * (D-136, Phase 1 of `docs/notes/on-canvas-transform.md`). The owner's
 * original ask: "the player is canvas — once I have another video I can
 * select, drag and make it smaller or larger, PIP etc."
 *
 * Renders as a sibling of `PreviewPane.tsx`'s `<img>`, absolutely positioned
 * over the same wrapper `<div>` — no `@chroma/player` change needed, `Player`
 * already accepts an arbitrary `surface` ReactNode (see that package's own
 * contract doc). Draws a box + corner handles for the ONE selected clip
 * (`useEditorTimelineStore.selection`, D-107/D-118) — nothing when
 * `selection.length !== 1`, the same Phase-1 multi-select fallback every
 * other single-clip-only consumer in this tab already applies
 * (`EditorInspectorPanel.tsx`). Clicking on the picture to select is
 * deliberately deferred (see the note's own Phase 1 section) — this
 * component only ever REFLECTS the timeline-side selection, never sets it.
 *
 * **The box's geometry is composition-fraction space (D-136), not screen
 * pixels or canvas pixels.** `chroma_timeline_clip_geometry` (Rust,
 * `chroma::edit::clip_geometry`) is the one thing the frontend cannot derive
 * on its own — a clip's own source resolution, measured against the
 * project's composition — everything else (`position_x`/`position_y`/
 * `scale`) is already a normalised fraction on `Clip` itself post-migration.
 * `transformGeometry.ts` does the actual fraction<->screen-pixel math (pure,
 * unit-tested there — this component is DOM/pointer wiring around it, not
 * itself unit-tested, matching this package's `node`-only vitest
 * environment).
 *
 * **Live overlay-only feedback during a drag; ONE `set_clip_transform` op on
 * pointer-up.** Mirrors `RelightPuckLayer.tsx`/D-046's own pattern, which
 * exists for exactly this reason (Phase 0b of the note): `applyOp` pushes a
 * whole-timeline undo snapshot on every call, so a naive
 * `onPointerMove -> applyOp` would flood the undo stack. The picture itself
 * does NOT re-composite live while dragging — `PreviewPane`'s frame is a
 * server-rendered JPEG per the note's own "no cheap live re-render" finding
 * — only this component's own CSS position/size updates per pointermove;
 * the composited picture catches up once the drag commits and the next
 * frame is fetched.
 *
 * Not in Phase 1 (see the note): rotation, non-uniform scale (via on-canvas
 * DRAGGING — see D-193's own note on this component below), crop, anchor
 * point, click-to-select, snapping/guides, marquee, multi-clip transform.
 *
 * **D-193 — independent `box_width`/`box_height` (the Inspector's new
 * Width/Height/ratio-lock control) render correctly here (the STATIC box,
 * whenever no drag is in flight, uses them when the clip has them), but
 * dragging a corner handle stays Phase-1 uniform-only and, on release,
 * ALWAYS commits a plain `scale` and clears both overrides back to `null`
 * — an on-canvas resize is a deliberately simpler, uniform gesture, and
 * silently only-partially-respecting an existing non-uniform override
 * would be worse than this explicit, documented "resizing on canvas
 * re-uniforms the box" contract. Precise independent sizing stays an
 * Inspector-only affordance for now (see that panel's own doc). A plain
 * MOVE (reposition) drag never touches box size and always preserves
 * whatever override already existed.
 */
import { useEffect, useRef, useState } from 'react';
import { useContentBox } from '@chroma/player';

import { findClip } from './timeline';
import { useEditorTimelineStore } from './timelineStore';
import { useClipGeometry } from './useClipGeometry';
import {
  boxToScreenRect,
  clipBoxFraction,
  dragCornerScale,
  dragReposition,
  screenToFraction,
} from './transformGeometry';

/** Screen-pixel handle size + hit-slop, and the box stroke width — named
 *  constants per the house no-magic-numbers rule, not tuned against
 *  anything deeper than "comfortable to grab with a mouse." */
const HANDLE_SIZE = 10;
const HANDLE_HIT_SLOP = 6;
const BOX_STROKE_WIDTH = 1.5;

type Corner = 'nw' | 'ne' | 'sw' | 'se';
const CORNERS: Corner[] = ['nw', 'ne', 'sw', 'se'];

/** In-flight gesture state — local, uncommitted (Phase 0b). `null` when no
 *  drag is active. */
type DragState =
  | { kind: 'move'; startPoint: { x: number; y: number }; startPosition: { x: number; y: number } }
  | { kind: 'scale'; startPoint: { x: number; y: number }; center: { x: number; y: number }; startScale: number };

export function TransformOverlay({ containerRef }: { containerRef: React.RefObject<HTMLElement | null> }) {
  const timeline = useEditorTimelineStore((s) => s.timeline);
  const selection = useEditorTimelineStore((s) => s.selection);
  const applyOp = useEditorTimelineStore((s) => s.applyOp);

  // Same Phase-1 multi-select fallback `EditorInspectorPanel.tsx` already
  // uses: a selection that isn't exactly one clip draws nothing.
  const primary = selection.length === 1 ? selection[0] : null;
  const found = primary ? findClip(timeline, primary.track, primary.id) : null;
  const clip = found?.clip ?? null;
  const clipIndex = found?.index ?? -1;
  const trackLocked = primary ? !!timeline?.tracks[primary.track]?.locked : false;

  const geometry = useClipGeometry(primary?.track ?? null, clipIndex, clip?.source_path);

  const contentBox = useContentBox(
    containerRef,
    geometry ? { width: geometry.compWidth, height: geometry.compHeight } : null,
  );

  // The in-flight drag (Phase 0b: local + uncommitted; one `applyOp` on
  // release). `draft` is what the box actually renders while dragging —
  // `null` means "render straight from the committed clip fields."
  const dragRef = useRef<DragState | null>(null);
  const [draft, setDraft] = useState<{ position: { x: number; y: number }; scale: number } | null>(null);

  const committedPosition = { x: clip?.position_x ?? 0, y: clip?.position_y ?? 0 };
  const committedScale = clip?.scale ?? 1;
  const position = draft?.position ?? committedPosition;
  const scale = draft?.scale ?? committedScale;

  // D-201 — no `useCallback` here, nor on `commit` below, deliberately. The
  // React Compiler (D-091) auto-memoizes this whole component, but only when it
  // can *preserve* every piece of memoization already written by hand; these
  // two made it bail out of `TransformOverlay` entirely ("Existing memoization
  // could not be preserved" — one for a dependency it saw as mutated later, one
  // for a value it does not need to memoize at all), which costs the component
  // every bit of auto-memoization it would otherwise get. This is the
  // highest-update-frequency surface in the Edit tab's preview (an on-canvas
  // move/scale drag), so bailing out here is exactly the wrong trade. Leave
  // these plain — the compiler memoizes them with dependencies it infers
  // itself, which is also strictly safer than a hand-maintained array.
  // `reactCompiler.test.ts` fails if a future edit reintroduces a bailout here.
  const localPoint = (e: { clientX: number; clientY: number }) => {
    const el = containerRef.current;
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    return screenToFraction({ x: e.clientX - rect.left, y: e.clientY - rect.top }, contentBox);
  };

  const cancelDrag = () => {
    dragRef.current = null;
    setDraft(null);
  };

  // Escape cancels the in-flight gesture (the note's own Phase 1 spec) —
  // listened for only while a drag is actually active.
  useEffect(() => {
    if (!draft) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancelDrag();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [draft, cancelDrag]);

  const commit = (next: { position: { x: number; y: number }; scale: number }, kind: 'move' | 'scale') => {
    if (!primary || !clip || clipIndex < 0) return;
    applyOp({
      kind: 'set_clip_transform',
      track: primary.track,
      clip: clipIndex,
      opacity: clip.opacity ?? 1,
      position_x: next.position.x,
      position_y: next.position.y,
      scale: next.scale,
      // D-193 — a corner (scale) drag stays Phase-1 uniform-only (see this
      // module's own doc above): committing one always clears any
      // independent `box_width`/`box_height` override back to `null`, so
      // the box actually ends up the uniform size just dragged rather
      // than silently keeping a stale, now-wrong override. A plain MOVE
      // drag never resizes anything, so it preserves whatever override
      // already existed untouched.
      box_width: kind === 'scale' ? null : clip.box_width ?? null,
      box_height: kind === 'scale' ? null : clip.box_height ?? null,
      rotation: clip.rotation ?? 0,
      crop_left: clip.crop_left ?? 0,
      crop_top: clip.crop_top ?? 0,
      crop_right: clip.crop_right ?? 0,
      crop_bottom: clip.crop_bottom ?? 0,
    });
  };

  const handleBodyPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || trackLocked) return;
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const startPoint = localPoint(e);
    dragRef.current = { kind: 'move', startPoint, startPosition: committedPosition };
    setDraft({ position: committedPosition, scale: committedScale });
  };

  const handleCornerPointerDown = (corner: Corner) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || trackLocked) return;
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const startPoint = localPoint(e);
    const center = { x: 0.5 + committedPosition.x, y: 0.5 + committedPosition.y };
    dragRef.current = { kind: 'scale', startPoint, center, startScale: committedScale };
    setDraft({ position: committedPosition, scale: committedScale });
    void corner; // Phase 1 is uniform-only — every corner drives the same math (see note).
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    e.stopPropagation();
    const point = localPoint(e);
    if (drag.kind === 'move') {
      setDraft({ position: dragReposition(drag.startPoint, point, drag.startPosition), scale: committedScale });
    } else {
      setDraft({ position: committedPosition, scale: dragCornerScale(drag.center, drag.startPoint, point, drag.startScale) });
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    e.stopPropagation();
    dragRef.current = null;
    const kind = drag.kind;
    // Read the live draft state rather than recomputing — it's already
    // exactly what was last rendered, and pointerup itself can land a
    // fraction of a pixel from the last pointermove.
    setDraft((current) => {
      if (current) commit(current, kind);
      return null;
    });
  };

  if (!clip || !geometry || contentBox.width <= 0 || contentBox.height <= 0) return null;

  // D-193 — while a drag is live, the box always follows the natural*scale
  // formula (Phase 1's uniform-only drag math, unchanged). At rest, an
  // independent `box_width`/`box_height` override (set via the Inspector)
  // takes over per axis — passing the already-resolved size through as
  // `natural` with `scale: 1` reuses `clipBoxFraction` unchanged rather
  // than needing a second box-math variant.
  const box = draft
    ? clipBoxFraction({ width: geometry.naturalWidth, height: geometry.naturalHeight }, position, scale)
    : clipBoxFraction(
        {
          width: clip.box_width ?? geometry.naturalWidth * committedScale,
          height: clip.box_height ?? geometry.naturalHeight * committedScale,
        },
        position,
        1,
      );
  const rect = boxToScreenRect(box, contentBox);

  return (
    <div className="absolute inset-0 pointer-events-none z-30" data-transform-overlay>
      <div
        className="absolute border-accent"
        style={{
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          borderWidth: BOX_STROKE_WIDTH,
          boxSizing: 'border-box',
        }}
      >
        {/* Body — reposition. Fully covers the box so a grab anywhere on the
            clip (not just its exact edge) starts a move, matching Premiere/
            Resolve's own "drag the picture" body affordance. */}
        <div
          className={trackLocked ? 'absolute inset-0' : 'absolute inset-0 pointer-events-auto cursor-move'}
          onPointerDown={handleBodyPointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        />
        {!trackLocked &&
          CORNERS.map((corner) => {
            const isTop = corner[0] === 'n';
            const isLeft = corner[1] === 'w';
            // The pointer TARGET is `HANDLE_HIT_SLOP` bigger on every side
            // than the VISIBLE handle — grabbing a corner shouldn't need
            // pixel accuracy. Outer div is the (invisible) hit area,
            // centred on the corner; inner div is the drawn square,
            // centred inside it via flex.
            const hit = HANDLE_SIZE + HANDLE_HIT_SLOP * 2;
            return (
              <div
                key={corner}
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
                onPointerDown={handleCornerPointerDown(corner)}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
              >
                <div className="rounded-sm border border-accent bg-bg-primary" style={{ width: HANDLE_SIZE, height: HANDLE_SIZE }} />
              </div>
            );
          })}
      </div>
    </div>
  );
}
