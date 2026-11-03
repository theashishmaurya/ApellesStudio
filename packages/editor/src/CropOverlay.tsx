/**
 * @apelles/editor — the viewer's crop mode (v0.3.0 panel redesign, B-366,
 * D-443; the owner on revision 1: "crop should be interactive, not like
 * this").
 *
 * **What it is.** Final Cut's Crop button, Trim mode: the Inspector's Crop
 * header button arms `timelineStore.cropEdit` for the selected clip, and this
 * overlay draws that clip's kept picture with a handle on each of its four
 * edges, everything outside it dimmed, and the whole source's outline dashed
 * (how far each edge can go back out). Dragging an edge moves only that edge;
 * releasing commits ONE op (`cropEditOp`), so one drag is one undo step.
 * Esc or Enter (or the header button again) ends the mode. Selecting another
 * clip hides the handles (the mode is by clip id, like dynamic zoom's).
 *
 * **Why the picture stays put.** `cropEditOp` writes the crop together with
 * the placement that keeps the kept part of the picture on the same pixels
 * (`cropInPlace.ts`'s module doc has the B-218 reason this is needed), so the
 * edge you let go of is where the picture's edge stays.
 *
 * **What it does NOT do.** Show the cropped-away pixels: the preview renders
 * the persisted crop, so outside the kept rectangle you see what is under the
 * clip, dimmed, not the trimmed picture (Final Cut shows it ghosted; this
 * renderer has no uncropped pass). It never runs for a title, a caption, an
 * adjustment clip or a locked track, and it never sets the selection.
 */
import { useEffect, useRef, useState } from 'react';

import { clipSourceFrame, resolveClipBoxTransform } from './clipKeyframes';
import {
  CROP_EDGES,
  clampCropInsets,
  cropEditOp,
  cropKeptRect,
  cropSourceRect,
  type CropEdge,
  type CropInsetValues,
} from './cropInPlace';
import { canvasTarget } from './inspectorTarget';
import { timelineFps } from './timeline';
import { useEditorTimelineStore } from './timelineStore';
import { transformOverlayPlayhead } from './TransformOverlay';
import { boxToScreenRect, paintedClipBox, screenToFraction } from './transformGeometry';
import { useClipGeometry } from './useClipGeometry';
import { usePreviewContentBox } from './usePreviewContentBox';

/** The edge handles: a bar along the middle of each edge, long and thin like
 *  Final Cut's, with a wider invisible hit band. */
const HANDLE_LONG_PX = 28;
const HANDLE_THICK_PX = 4;
const HANDLE_HIT_PX = 12;

const EDGE_LABEL: Readonly<Record<CropEdge, string>> = {
  crop_left: 'left',
  crop_right: 'right',
  crop_top: 'top',
  crop_bottom: 'bottom',
};

export function CropOverlay({ container }: { container: HTMLElement | null }) {
  const timeline = useEditorTimelineStore((s) => s.timeline);
  const selection = useEditorTimelineStore((s) => s.selection);
  const cropEdit = useEditorTimelineStore((s) => s.cropEdit);
  const setCropEdit = useEditorTimelineStore((s) => s.setCropEdit);
  const applyOp = useEditorTimelineStore((s) => s.applyOp);
  const playhead = useEditorTimelineStore(transformOverlayPlayhead);

  const picture = canvasTarget(timeline, selection.length === 1 ? selection[0] : null);
  const clip = picture?.clip ?? null;
  const armed = !!cropEdit && !!clip && clip.id === cropEdit.clipId && !clip.text && !clip.caption && !clip.adjustment;
  const locked = picture ? !!timeline?.tracks[picture.track]?.locked : false;

  // Only an armed overlay measures anything (B-374's rule for the dynamic
  // zoom overlay: an IPC round trip and a forced layout per selection change
  // for a box that draws nothing would be pure cost).
  const geometry = useClipGeometry(armed && picture ? picture.track : null, picture?.index ?? -1, clip?.source_path, clip?.scaling);
  const contentBox = usePreviewContentBox(
    armed ? container : null,
    geometry ? { width: geometry.compWidth, height: geometry.compHeight } : null,
  );

  /** The in-flight drag's insets (null at rest: the stored crop shows). */
  const [draft, setDraft] = useState<CropInsetValues | null>(null);
  const dragRef = useRef<{ pointerId: number; edge: CropEdge; start: CropInsetValues } | null>(null);

  // Esc / Enter end the mode (Final Cut's Done). Not while dragging: Esc
  // then cancels the drag first.
  useEffect(() => {
    if (!armed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && e.key !== 'Enter') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (dragRef.current) {
        if (e.key === 'Escape') {
          dragRef.current = null;
          setDraft(null);
        }
        return;
      }
      e.preventDefault();
      setCropEdit(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [armed, setCropEdit]);

  if (!armed || !clip || !picture || !geometry || contentBox.width <= 0 || contentBox.height <= 0) return null;

  const fps = timelineFps(timeline);
  const sourceFrame = clipSourceFrame(clip, playhead, fps);
  const effective = resolveClipBoxTransform(clip, sourceFrame);
  const natural = { width: geometry.naturalWidth, height: geometry.naturalHeight };
  const stored: CropInsetValues = {
    crop_left: effective.crop_left,
    crop_top: effective.crop_top,
    crop_right: effective.crop_right,
    crop_bottom: effective.crop_bottom,
  };
  const box = paintedClipBox(clip, natural, effective);
  const source = cropSourceRect(box, stored);
  const crop = draft ?? stored;
  const kept = boxToScreenRect(cropKeptRect(source, crop), contentBox);
  const whole = boxToScreenRect(source, contentBox);

  const localPoint = (e: { clientX: number; clientY: number }) => {
    const r = container?.getBoundingClientRect();
    return screenToFraction({ x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) }, contentBox);
  };

  const insetsAt = (edge: CropEdge, start: CropInsetValues, e: { clientX: number; clientY: number }) => {
    const p = localPoint(e);
    const v =
      edge === 'crop_left'
        ? (p.x - source.left) / source.width
        : edge === 'crop_right'
          ? (source.left + source.width - p.x) / source.width
          : edge === 'crop_top'
            ? (p.y - source.top) / source.height
            : (source.top + source.height - p.y) / source.height;
    return clampCropInsets({ ...start, [edge]: v }, edge);
  };

  const onPointerDown = (edge: CropEdge) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (locked || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // The pointer is already gone; pointerup still finishes the drag.
    }
    dragRef.current = { pointerId: e.pointerId, edge, start: stored };
    setDraft(stored);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = dragRef.current;
    if (!g || e.pointerId !== g.pointerId) return;
    setDraft(insetsAt(g.edge, g.start, e));
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = dragRef.current;
    if (!g || e.pointerId !== g.pointerId) return;
    dragRef.current = null;
    const next = insetsAt(g.edge, g.start, e);
    setDraft(null);
    const op = cropEditOp({ track: picture.track, index: picture.index, clip }, sourceFrame, natural, next, g.edge);
    if (op) applyOp(op);
  };

  const onPointerCancel = () => {
    dragRef.current = null;
    setDraft(null);
  };

  /** The handle bar for one edge, centred on that edge of the kept rect. */
  const handleStyle = (edge: CropEdge): React.CSSProperties => {
    const horizontal = edge === 'crop_top' || edge === 'crop_bottom';
    const cx = edge === 'crop_left' ? kept.left : edge === 'crop_right' ? kept.left + kept.width : kept.left + kept.width / 2;
    const cy = edge === 'crop_top' ? kept.top : edge === 'crop_bottom' ? kept.top + kept.height : kept.top + kept.height / 2;
    const w = horizontal ? HANDLE_LONG_PX : HANDLE_HIT_PX;
    const h = horizontal ? HANDLE_HIT_PX : HANDLE_LONG_PX;
    return { left: cx - w / 2, top: cy - h / 2, width: w, height: h, cursor: horizontal ? 'ns-resize' : 'ew-resize' };
  };

  return (
    <div className="pointer-events-none absolute inset-0 z-30" data-crop-overlay>
      {/* Dim everything outside the kept picture: ONE full-size layer with
          the kept rectangle cut out by an even-odd clip path. A drag then
          changes only the clip path (a repaint of one layer), not the layout
          of four bands — measured live, the four-band version dropped 8–12 %
          of the drag's frames. */}
      <div
        className="bg-bg-primary/60 absolute inset-0"
        style={{
          clipPath: `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${kept.left}px ${kept.top}px, ${kept.left}px ${kept.top + kept.height}px, ${kept.left + kept.width}px ${kept.top + kept.height}px, ${kept.left + kept.width}px ${kept.top}px, ${kept.left}px ${kept.top}px)`,
        }}
        data-crop-dim
      />
      {/* The whole source: how far an edge can go back out. */}
      <div
        className="border-text-tertiary absolute border border-dashed"
        style={{ left: whole.left, top: whole.top, width: whole.width, height: whole.height }}
        data-crop-source
      />
      <div
        className="border-selection absolute border"
        style={{ left: kept.left, top: kept.top, width: kept.width, height: kept.height }}
        data-crop-kept
      />
      {CROP_EDGES.map((edge) => {
        const horizontal = edge === 'crop_top' || edge === 'crop_bottom';
        return (
          <div
            key={edge}
            role="slider"
            aria-label={`Crop ${EDGE_LABEL[edge]} edge`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(crop[edge] * 100)}
            aria-valuetext={`${Math.round(crop[edge] * 100)} %`}
            aria-disabled={locked || undefined}
            data-crop-handle={edge}
            className="pointer-events-auto absolute flex touch-none items-center justify-center"
            style={handleStyle(edge)}
            onPointerDown={onPointerDown(edge)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
          >
            <span
              className="bg-selection rounded-full"
              style={horizontal ? { width: HANDLE_LONG_PX, height: HANDLE_THICK_PX } : { width: HANDLE_THICK_PX, height: HANDLE_LONG_PX }}
            />
          </div>
        );
      })}
      <div className="bg-bg-primary/80 text-text-primary absolute top-2 left-1/2 -translate-x-1/2 rounded-full px-2.5 py-0.5 text-xs whitespace-nowrap">
        Drag the edges to crop · Esc or ⏎ when done
      </div>
    </div>
  );
}
