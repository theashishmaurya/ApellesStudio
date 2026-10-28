/**
 * @apelles/editor — the viewer's draggable highlight boxes (D-396).
 *
 * What it is: when the Inspector's "Edit boxes" is on for the selected clip,
 * draws that clip's highlight boxes over the picture, where the words are. A
 * body drag moves a box; the bottom-right handle resizes it. One
 * `set_clip_highlights` op on release, so a drag is one undo step.
 *
 * What it does NOT do: hold a second copy of the boxes. They are read back from
 * the clip every render (the `DynamicZoomOverlay` rule), and the in-flight drag
 * is a local draft that is dropped on release. It draws nothing for a rotated
 * clip (the picture is not axis-aligned with its placement box; the Inspector
 * rows still edit the numbers), a clip the playhead is not over, a locked
 * track, or a clip that is not armed. Every position goes through
 * `highlightGeometry.ts`, so the box sits on the same pixels the compositor
 * paints, crop and keyframed push-in included.
 */
import { useRef, useState } from 'react';
import { usePreviewContentBox } from './usePreviewContentBox';
import { clipSourceFrame, hasParamKeyframes, resolveClipBoxTransform } from './clipKeyframes';
import { clipCoversFrame, findClip, timelineFps } from './timeline';
import { useEditorTimelineStore } from './timelineStore';
import { useClipGeometry } from './useClipGeometry';
import { useHighlightEditStore } from './highlightEditStore';
import { compositionToHighlight, highlightToComposition } from './highlightGeometry';
import { sanitizeHighlight, type ClipHighlight } from './clipHighlights';
import {
  boxToScreenRect,
  clipBoxAnchor,
  clipBoxFraction,
  resolvedBoxSize,
  type FractionBox,
} from './transformGeometry';

/** A drag in flight: which highlight, what gesture, and where it started. */
interface Drag {
  index: number;
  kind: 'move' | 'resize';
  startX: number;
  startY: number;
  /** The highlight's box when the drag began, in source-image fractions. */
  origin: ClipHighlight['box'];
}

const MIN_BOX = 0.01;

export function HighlightOverlay({ container }: { container: HTMLElement | null }) {
  const timeline = useEditorTimelineStore((s) => s.timeline);
  const playhead = useEditorTimelineStore((s) => s.playhead);
  const selection = useEditorTimelineStore((s) => s.selection);
  const applyOp = useEditorTimelineStore((s) => s.applyOp);
  const armedClipId = useHighlightEditStore((s) => s.armedClipId);
  const selected = useHighlightEditStore((s) => s.selected);
  const select = useHighlightEditStore((s) => s.select);

  const primary = selection.length === 1 ? selection[0] : null;
  const found = primary ? findClip(timeline, primary.track, primary.id) : null;
  const clip = found?.clip ?? null;
  const track = primary ? (timeline?.tracks[primary.track] ?? null) : null;
  const armed = !!clip && clip.id === armedClipId;
  const onScreen = !!clip && !!track && !track.hidden && clipCoversFrame(clip, playhead, timelineFps(timeline));

  const geometry = useClipGeometry(
    armed && onScreen ? (primary?.track ?? null) : null,
    armed && onScreen ? (found?.index ?? -1) : -1,
    clip?.source_path,
    clip?.scaling,
  );
  const contentBox = usePreviewContentBox(
    container,
    geometry ? { width: geometry.compWidth, height: geometry.compHeight } : null,
  );

  const [draft, setDraft] = useState<{ index: number; box: ClipHighlight['box'] } | null>(null);
  // The gesture's start lives in a ref (it changes no rendering); the box being
  // dragged is `draft` state, and the handlers are re-created every render, so
  // `end` sees the value the last move rendered.
  const drag = useRef<Drag | null>(null);

  if (!armed || !clip || !found || !primary || !onScreen || !geometry || !track) return null;
  if (contentBox.width <= 0 || contentBox.height <= 0) return null;

  const fps = timelineFps(timeline);
  const effective = resolveClipBoxTransform(clip, clipSourceFrame(clip, playhead, fps));
  if (!effective || (clip.rotation ?? 0) !== 0 || hasParamKeyframes(clip.chroma_keyframes, 'rotation')) return null;
  const natural = { width: geometry.naturalWidth, height: geometry.naturalHeight };
  const crop = {
    left: effective.crop_left,
    top: effective.crop_top,
    right: effective.crop_right,
    bottom: effective.crop_bottom,
  };
  const size = resolvedBoxSize(natural, effective.scale, { width: effective.box_width, height: effective.box_height }, crop);
  const placement: FractionBox = {
    ...clipBoxFraction(natural, { x: effective.position_x, y: effective.position_y }, effective.scale, clipBoxAnchor(clip)),
    ...size,
  };
  const highlights = clip.highlights ?? [];
  const locked = !!track.locked;

  const begin = (index: number, kind: Drag['kind']) => (e: React.PointerEvent) => {
    if (locked) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    select(index);
    drag.current = { index, kind, startX: e.clientX, startY: e.clientY, origin: highlights[index].box };
  };

  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    // Pixel delta -> composition fractions -> source-image fractions through the
    // same mapping that drew the box, so the box follows the pointer 1:1.
    const dxComp = (e.clientX - d.startX) / contentBox.width;
    const dyComp = (e.clientY - d.startY) / contentBox.height;
    const startBox = highlightToComposition(d.origin, placement, crop);
    if (!startBox) return;
    const next: FractionBox =
      d.kind === 'move'
        ? { ...startBox, left: startBox.left + dxComp, top: startBox.top + dyComp }
        : {
            ...startBox,
            width: Math.max(MIN_BOX * placement.width, startBox.width + dxComp),
            height: Math.max(MIN_BOX * placement.height, startBox.height + dyComp),
          };
    const box = compositionToHighlight(next, placement, crop);
    if (box) setDraft({ index: d.index, box });
  };

  const end = () => {
    const d = drag.current;
    drag.current = null;
    const final = draft;
    setDraft(null);
    if (!d || !final || final.index !== d.index) return;
    const cleaned = sanitizeHighlight({ ...highlights[d.index], box: final.box });
    if (!cleaned) return;
    applyOp({
      kind: 'set_clip_highlights',
      track: primary.track,
      clip: found.index,
      highlights: highlights.map((h, i) => (i === d.index ? cleaned : h)),
    });
  };

  return (
    <div className="absolute inset-0 pointer-events-none z-40" data-highlight-overlay>
      {highlights.map((h, i) => {
        const box = draft?.index === i ? draft.box : h.box;
        const comp = highlightToComposition(box, placement, crop);
        if (!comp) return null;
        const r = boxToScreenRect(comp, contentBox);
        const isSelected = selected === i;
        return (
          <div
            key={i}
            className={`absolute pointer-events-auto touch-none border-2 ${isSelected ? 'border-accent' : 'border-accent/60 border-dashed'} ${locked ? '' : 'cursor-move'}`}
            style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
            onPointerDown={begin(i, 'move')}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
            data-highlight-box={i}
          >
            <span className="bg-accent text-button-text absolute -top-4 left-0 rounded px-1 text-[10px] leading-4">
              {i + 1}
            </span>
            {!locked && (
              <div
                className="bg-accent absolute -right-1.5 -bottom-1.5 size-3 cursor-nwse-resize rounded-sm"
                onPointerDown={begin(i, 'resize')}
                onPointerMove={move}
                onPointerUp={end}
                onPointerCancel={end}
                data-highlight-resize={i}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
