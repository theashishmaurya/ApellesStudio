/**
 * @apelles/editor — the preview's platform safe-area guide (D-431).
 *
 * What it is: when the Safe Area menu (or `editor_set_safe_area_view`) picks a
 * preset, draws that preset's safe rectangle(s) over the picture, with the
 * unsafe margin tinted — where a platform's own UI (captions, channel name,
 * buttons, progress bar) will sit on top of the video.
 *
 * What it does NOT do: it is a view aid. `pointer-events: none` (it never
 * intercepts a drag meant for `TransformOverlay`), it is not part of the frame
 * the compositor renders, and no export path reads it. It holds no geometry of
 * its own — every rectangle comes from `safeAreas.ts` — and it re-renders only
 * when the preset, the composition size or the viewport zoom/pan changes,
 * never per played frame (the picture is written straight to the `<img>`,
 * D-290).
 *
 * Positioning: the same `usePreviewContentBox` rect `CanvasBoundary` uses, so
 * the guide tracks the picture's real edges at every zoom level (D-218). Colours
 * are the existing `--color-*` tokens only.
 */
import { usePreviewContentBox } from './usePreviewContentBox';
import type { CompositionSize } from './useCompositionSize';
import { presetRects, safeAreaPreset } from './safeAreas';
import { useEditorTimelineStore } from './timelineStore';

const LABEL_MARGIN = 4;

export function SafeAreaOverlay({
  container,
  size,
}: {
  container: HTMLElement | null;
  size: CompositionSize | null;
}) {
  const view = useEditorTimelineStore((s) => s.safeAreaView);
  const box = usePreviewContentBox(container, size);
  if (view === 'off' || !size || box.width <= 0 || box.height <= 0) return null;

  const preset = safeAreaPreset(view);
  const rects = presetRects(preset, size.width, size.height);
  const sx = box.width / size.width;
  const sy = box.height / size.height;
  // The outermost rectangle bounds the tinted margin; any nested one (the
  // broadcast title-safe inside action-safe) is outline-only.
  const outer = rects[0];
  const left = outer.x * sx;
  const top = outer.y * sy;
  const width = outer.width * sx;
  const height = outer.height * sy;
  const tint = 'absolute bg-bg-primary/45';

  return (
    <div
      className="absolute pointer-events-none z-20 overflow-hidden"
      data-safe-area-overlay={view}
      style={{ left: box.offsetX, top: box.offsetY, width: box.width, height: box.height }}
    >
      <div className={tint} data-safe-area-band="top" style={{ left: 0, top: 0, width: box.width, height: top }} />
      <div
        className={tint}
        data-safe-area-band="bottom"
        style={{ left: 0, top: top + height, width: box.width, height: Math.max(0, box.height - top - height) }}
      />
      <div className={tint} data-safe-area-band="left" style={{ left: 0, top, width: left, height }} />
      <div
        className={tint}
        data-safe-area-band="right"
        style={{ left: left + width, top, width: Math.max(0, box.width - left - width), height }}
      />
      {rects.map((r) => (
        <div
          key={r.id}
          className="absolute border border-accent/70"
          data-safe-area-rect={r.id}
          style={{ left: r.x * sx, top: r.y * sy, width: r.width * sx, height: r.height * sy, boxSizing: 'border-box' }}
        >
          <span
            className="absolute rounded-sm bg-bg-primary/80 px-1 text-[10px] leading-tight text-text-secondary"
            style={{ left: LABEL_MARGIN, top: LABEL_MARGIN }}
          >
            {r.label}
          </span>
        </div>
      ))}
    </div>
  );
}
