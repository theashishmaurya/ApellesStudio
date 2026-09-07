/**
 * @chroma/editor — the Edit-tab preview's canvas/composition boundary
 * overlay (D-199, `docs/notes/preview-canvas-boundary.md`).
 *
 * **The gap this closes.** The preview `<img>` is `object-contain`-fit
 * within its wrapper, so its own rendered edges already happen to coincide
 * with the composition's — but nothing ever said so explicitly, and that
 * coincidence is invisible when nothing has loaded yet, when the player's
 * `bg-bg-primary` letterbox bars are subtle against a dark clip, or simply
 * because a human looking at "a picture that fills the box" has no way to
 * confirm the box IS the real output frame rather than one clip's own
 * decoded size (which is exactly what the picture looked like BEFORE D-136
 * fixed the compositor to always canvas-size the picture — see that
 * decision, and B-043). A persistent, explicit rectangle removes the
 * ambiguity outright rather than relying on an implicit coincidence.
 *
 * **Independent of selection**, unlike `TransformOverlay` (which only draws
 * for exactly one selected clip): this renders whenever the timeline has a
 * resolvable composition size at all, selection or none, so the frame is
 * visible the moment a project is open. Sibling of `TransformOverlay` in
 * `PreviewPane.tsx`'s stacking — drawn UNDER it (lower z-index): the
 * transform handles are the more specific, actionable affordance and should
 * never be visually competing with a static reference frame.
 *
 * Same `useContentBox` letterbox math `TransformOverlay.tsx` already uses —
 * the composition boundary and the picture's own `object-contain` box are
 * computed from the exact same (width, height) pair by construction, so they
 * always agree pixel-for-pixel; this is not a second, independently-derived
 * rectangle that could drift from what the picture actually shows.
 */
import { useContentBox } from '@chroma/player';
import type { CompositionSize } from './useCompositionSize';

const LABEL_MARGIN = 4;

export function CanvasBoundary({
  containerRef,
  size,
}: {
  containerRef: React.RefObject<HTMLElement | null>;
  size: CompositionSize | null;
}) {
  const contentBox = useContentBox(containerRef, size);
  if (!size || contentBox.width <= 0 || contentBox.height <= 0) return null;

  return (
    <div
      className="absolute pointer-events-none z-20 border border-text-secondary/40"
      data-canvas-boundary
      style={{
        left: contentBox.offsetX,
        top: contentBox.offsetY,
        width: contentBox.width,
        height: contentBox.height,
        boxSizing: 'border-box',
      }}
    >
      <span
        className="absolute rounded-sm bg-bg-primary/80 px-1 text-[10px] leading-tight text-text-secondary"
        style={{ left: LABEL_MARGIN, top: LABEL_MARGIN }}
      >
        {size.width}×{size.height}
      </span>
    </div>
  );
}
