/**
 * @apelles/editor — the timeline curve editor lane (D-233, roadmap item 27:
 * "Bezier ease curves under a clip, editable directly").
 *
 * What it is: a lane docked under the timeline's track area, time-aligned with
 * it, plotting ONE animated property of ONE clip as a real bezier curve with
 * its keyframes as dots and each segment's two control points as draggable
 * handles. Built from DaVinci Resolve's own inline clip curve editor
 * (`scratch/resolve-reference/curve.jpg`), element for element: a header strip
 * carrying the property's name, its four ease presets and a keyframe
 * navigator, then a plot whose value range is labelled at both ends.
 *
 * What it does NOT do:
 *   - It does not move keyframes in TIME or change their VALUES. It edits the
 *     shape *between* two keys and nothing else. Moving/adding/deleting keys
 *     is the Inspector's per-property diamond + nav (D-208), which already
 *     owns that and is one panel away; two editors that can both move a
 *     keyframe is two places for that behaviour to drift.
 *   - It does not interpolate anything itself. Every value it draws comes from
 *     `clipKeyframes.ts` (the same resolver the Inspector and the on-canvas
 *     box read), and every curve it draws is traced exactly by `curveEditor
 *     .ts`'s geometry. There is one interpolator in this package.
 *   - It does not own the x axis — see below.
 *
 * **Why a docked, resizable lane rather than expanding the clip's own row
 * in-place** (which is literally what Resolve does). Three reasons, in order
 * of weight, and the trade is written up in D-233:
 *   1. CLAUDE.md's standing rule — a pane holding real content the user will
 *      want more or less of must actually be resizable. A curve is exactly
 *      that: the taller the lane, the finer the ease you can author. An
 *      in-row expansion is a fixed height by construction.
 *   2. `TimelinePane`'s uniform `ROW_HEIGHT` is load-bearing for every
 *      drop-target, insert-preview and gap hit-test in that file (~20 sites of
 *      `index * ROW_HEIGHT` arithmetic). Making rows variable to host a
 *      transient editor would couple an editor's UI state into the track
 *      layout model — the track list's uniform height is not a defect to fix,
 *      it is a correct model of a track list.
 *   3. An in-row expansion displaces every track below it while you edit; a
 *      lane does not.
 * The lane still reads as belonging to its clip: it is time-aligned to the
 * frame, and the clip's own on-timeline span is drawn as the lit region with
 * everything outside it dimmed.
 *
 * **The x axis is the timeline's, not this component's.** `pxPerSec`,
 * `scrollLeft` and `startLeftPx` are passed in from `TimelinePane` — the same
 * three numbers its clips are positioned with — so a keyframe dot sits under
 * the exact frame of the clip above it at every zoom and scroll position.
 * Deriving a second mapping here is how the two would drift apart.
 *
 * Drag/commit follows the convention D-207's fade handles and D-136's
 * transform box already established, for the reason `applyOp` makes
 * unavoidable (it snapshots the whole timeline per call, so a per-pointermove
 * commit is one undo entry per pixel): live overlay-only feedback during the
 * drag, exactly one `applyOp` on pointer-up, nothing at all committed by a
 * drag that ends where it began, and Escape cancels.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { Button } from '@apelles/ui';

import {
  CLIP_KEYFRAME_DEFAULTS,
  EASE_PRESETS,
  easePresetName,
  type Clip,
  type ClipKeyframeParam,
  type EaseCurve,
} from './timeline';
import {
  adjacentParamKeyframeFrame,
  clipTimelineFrame,
  paramSegments,
  setClipKeyframeEase,
  type ParamSegment,
} from './clipKeyframes';
import {
  HANDLE_HIT_RADIUS_PX,
  curveValueRange,
  handleDragToEase,
  segmentHandlePoints,
  segmentPath,
  valueToY,
  type SegmentRect,
} from './curveEditor';
import { useEditorTimelineStore } from './timelineStore';

/** Vertical breathing room inside the plot, px — the curve never touches the
 *  lane's own border, so a keyframe dot at an extreme value is a whole dot. */
const PLOT_PAD_Y = 10;

/** Keyframe dot radius, px. */
const KEY_DOT_R = 4;
/** Control-handle dot radius, px. Smaller than a keyframe's on purpose: a
 *  handle is a modifier of the segment, not a thing on the timeline. */
const HANDLE_DOT_R = 3.5;

/** Human labels for the properties this lane can plot. Keyed by the same
 *  `ClipKeyframeParam` names `PropertyRow` uses, so the lane's header says
 *  what the Inspector row that opened it says. */
const PARAM_LABELS: Record<ClipKeyframeParam, string> = {
  opacity: 'Opacity',
  position_x: 'Position X',
  position_y: 'Position Y',
  scale: 'Scale',
  rotation: 'Rotation',
  crop_left: 'Crop Left',
  crop_top: 'Crop Top',
  crop_right: 'Crop Right',
  crop_bottom: 'Crop Bottom',
  volume: 'Volume',
  pan: 'Pan',
};

/** The in-flight handle drag — a ref, not state, so the window listeners
 *  never need re-binding to see it (the same reason `ClipFadeOverlay`'s own
 *  gesture state is a ref). */
interface HandleDrag {
  pointerId: number;
  /** Which segment of `segments`, and which of its two control points. */
  index: number;
  which: 1 | 2;
  /** The curve the segment had at pointer-down — what Escape restores to, and
   *  what pointer-up compares against to decide whether anything changed. */
  startEase: EaseCurve | null;
}

export interface ClipCurveEditorProps {
  clip: Clip;
  /** The clip's track index and its index within that track — what
   *  `set_clip_keyframes` addresses. */
  track: number;
  clipIndex: number;
  param: ClipKeyframeParam;
  /** The project's timeline fps, and the pane's own pixel mapping. See the
   *  module doc: this component does not derive its own. */
  fps: number;
  pxPerSec: number;
  scrollLeft: number;
  startLeftPx: number;
  /** A locked track's curves are drawn but not draggable — the same posture
   *  `ClipFadeOverlay` and `TransformOverlay` take. */
  disabled?: boolean;
  onClose: () => void;
}

export function ClipCurveEditor({
  clip,
  track,
  clipIndex,
  param,
  fps,
  pxPerSec,
  scrollLeft,
  startLeftPx,
  disabled = false,
  onClose,
}: ClipCurveEditorProps) {
  const applyOp = useEditorTimelineStore((s) => s.applyOp);
  const playhead = useEditorTimelineStore((s) => s.playhead);
  const setPlayhead = useEditorTimelineStore((s) => s.setPlayhead);

  const plotRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<HandleDrag | null>(null);
  /** The uncommitted curve of the segment being dragged. Overlay-only until
   *  pointer-up, per the module doc's drag/commit convention. */
  const [draft, setDraft] = useState<{ index: number; ease: EaseCurve } | null>(null);
  /** Whether a gesture is in flight. Separate from `draft` (which changes on
   *  every pointermove) purely so the window listeners below bind ONCE per
   *  drag rather than being torn down and rebuilt on each move — the same
   *  reason `ClipFadeOverlay` keys its own effect on `dragSide`. */
  const [dragging, setDragging] = useState(false);
  const [plotSize, setPlotSize] = useState({ width: 0, height: 0 });

  // The plot's own box, measured rather than assumed: the lane is inside a
  // ResizablePanel, so its height is whatever the user dragged it to and its
  // width is the edit area's. `ResizeObserver` rather than a layout effect on
  // every render — the pane resizes far more often than this component's props
  // change.
  useEffect(() => {
    const el = plotRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      setPlotSize({ width: el.clientWidth, height: el.clientHeight });
    });
    ro.observe(el);
    setPlotSize({ width: el.clientWidth, height: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const segments = useMemo(() => paramSegments(clip.chroma_keyframes, param), [clip.chroma_keyframes, param]);
  const staticValue = (clip[param] as number | undefined) ?? CLIP_KEYFRAME_DEFAULTS[param];
  const range = useMemo(() => curveValueRange(segments, staticValue), [segments, staticValue]);

  const plotHeight = Math.max(0, plotSize.height - PLOT_PAD_Y * 2);

  /** A clip SOURCE frame → x in the plot's own client coordinates. The exact
   *  mapping `TimelinePane` positions the clip above with, which is the whole
   *  point of taking those three numbers as props. */
  const xOf = useCallback(
    (sourceFrame: number) =>
      startLeftPx + (clipTimelineFrame(clip, sourceFrame, fps) / fps) * pxPerSec - scrollLeft,
    [clip, fps, pxPerSec, scrollLeft, startLeftPx],
  );

  const yOf = useCallback(
    (value: number) => PLOT_PAD_Y + valueToY(value, range, plotHeight),
    [range, plotHeight],
  );

  /** Each segment's screen rectangle, and the curve to draw it with — the
   *  draft curve for the segment under an in-flight drag, the committed one
   *  for every other. One memo so the paths, the handles and the hit test all
   *  agree about where things are. */
  const rects: SegmentRect[] = useMemo(
    () => segments.map((s) => ({ x0: xOf(s.fromFrame), y0: yOf(s.fromValue), x1: xOf(s.toFrame), y1: yOf(s.toValue) })),
    [segments, xOf, yOf],
  );
  const drawnEase = useCallback(
    (i: number): EaseCurve | null => (draft && draft.index === i ? draft.ease : segments[i].ease),
    [draft, segments],
  );

  /** The segment whose handles are shown. Exactly one at a time: every
   *  segment's handles at once is unreadable on a many-keyframe clip, which is
   *  also why Resolve shows the selected keyframe's handles only. Defaults to
   *  the segment the playhead is inside, so opening the lane while parked
   *  mid-animation puts the handles where you are already looking. */
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const activeIdx = useMemo(() => {
    if (selectedIdx !== null && selectedIdx < segments.length) return selectedIdx;
    const at = segments.findIndex(
      (s) => playhead >= clipTimelineFrame(clip, s.fromFrame, fps) && playhead <= clipTimelineFrame(clip, s.toFrame, fps),
    );
    return at >= 0 ? at : segments.length > 0 ? 0 : null;
  }, [selectedIdx, segments, playhead, clip, fps]);

  /** Write one segment's curve. `null` clears it back to linear. */
  const commitEase = useCallback(
    (index: number, curve: EaseCurve | null) => {
      const seg = segments[index];
      if (!seg) return;
      const next = setClipKeyframeEase(clip.chroma_keyframes, seg.fromFrame, param, curve);
      // Reference-equal means the write was a no-op (`setClipKeyframeEase`'s
      // own contract) — committing it anyway would push an undo entry for a
      // change that did not happen, since `set_clip_keyframes` rebuilds the
      // clip and so never compares equal to its input.
      if (next === clip.chroma_keyframes) return;
      applyOp({ kind: 'set_clip_keyframes', track, clip: clipIndex, keyframes: next ?? [] });
    },
    [applyOp, clip.chroma_keyframes, clipIndex, param, segments, track],
  );

  // ------------------------------------------------------------------ //
  // The handle drag
  // ------------------------------------------------------------------ //

  /** Start a drag of the active segment'''s control handle `which`.
   *
   *  Bound to the handle'''s own invisible grab circle rather than dispatched
   *  from a pointerdown on the whole plot: an SVG element hit-tests itself,
   *  correctly, respecting paint order and `pointer-events` — see
   *  `HANDLE_HIT_RADIUS_PX`'''s own doc for why the hand-rolled radial version
   *  this replaced was worse. */
  const startHandleDrag = (which: 1 | 2) => (e: React.PointerEvent<SVGCircleElement>) => {
    if (disabled || activeIdx === null || !segments[activeIdx]) return;
    e.stopPropagation();
    dragRef.current = {
      pointerId: e.pointerId,
      index: activeIdx,
      which,
      startEase: segments[activeIdx].ease,
    };
    setDraft({ index: activeIdx, ease: segments[activeIdx].ease ?? EASE_PRESETS[0].curve });
    setDragging(true);
  };

  useEffect(() => {
    if (!dragging) return;
    const finish = () => {
      dragRef.current = null;
      setDraft(null);
      setDragging(false);
    };

    const easeAt = (clientX: number, clientY: number, g: HandleDrag): EaseCurve => {
      const box = plotRef.current?.getBoundingClientRect();
      if (!box) return g.startEase ?? EASE_PRESETS[0].curve;
      return handleDragToEase(rects[g.index], g.startEase, g.which, clientX - box.left, clientY - box.top);
    };

    const onMove = (e: PointerEvent) => {
      const g = dragRef.current;
      if (!g || e.pointerId !== g.pointerId) return;
      setDraft({ index: g.index, ease: easeAt(e.clientX, e.clientY, g) });
    };

    const onUp = (e: PointerEvent) => {
      const g = dragRef.current;
      if (!g || e.pointerId !== g.pointerId) return;
      const next = easeAt(e.clientX, e.clientY, g);
      finish();
      // A drag that ends where it began commits nothing — the same rule the
      // fade handles follow, and the same reason (one undo entry per real
      // change, never per gesture).
      const before = g.startEase;
      if (before && before.x1 === next.x1 && before.y1 === next.y1 && before.x2 === next.x2 && before.y2 === next.y2) {
        return;
      }
      commitEase(g.index, next);
    };

    const onCancel = (e: PointerEvent) => {
      const g = dragRef.current;
      if (g && e.pointerId !== g.pointerId) return;
      finish();
    };
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
  }, [dragging, rects, commitEase]);

  // ------------------------------------------------------------------ //
  // Render
  // ------------------------------------------------------------------ //

  const label = PARAM_LABELS[param];
  const activeSeg: ParamSegment | null = activeIdx === null ? null : (segments[activeIdx] ?? null);
  const activeCurve = activeIdx === null ? null : drawnEase(activeIdx);
  const presetOfActive = activeSeg ? easePresetName(activeCurve) : null;
  const prevFrame = adjacentParamKeyframeFrame(clip.chroma_keyframes, param, playhead, -1);
  const nextFrame = adjacentParamKeyframeFrame(clip.chroma_keyframes, param, playhead, 1);

  // The clip's own on-timeline span — the lit region. Outside it the lane is
  // dimmed, so the lane visibly belongs to this clip rather than to the
  // timeline at large.
  const clipX0 = startLeftPx + (clip.start_frame / fps) * pxPerSec - scrollLeft;
  const clipX1 = xOf(clip.source_start + clip.duration);

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface" data-chroma-curve-editor={param}>
      {/* Header strip — Resolve's own row: the property, its ease presets,
          and a keyframe navigator. */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border-color px-2 py-1">
        <span className="text-text-primary text-[11px] font-semibold">{label}</span>
        <span className="text-text-secondary text-[10px]">{clip.name}</span>

        <div className="ml-2 flex items-center gap-1">
          {EASE_PRESETS.map((p) => (
            <Button
              key={p.name}
              variant={presetOfActive === p.name ? 'default' : 'ghost'}
              size="icon-xs"
              disabled={disabled || !activeSeg}
              onClick={() => {
                if (activeIdx === null) return;
                // `linear` clears the stored curve rather than storing the
                // linear preset. Both resolve identically (`isIdentityEase`),
                // but "no curve" is the shape every un-eased key already has,
                // so picking linear returns the data to exactly that rather
                // than leaving a curve behind that only happens to be straight.
                commitEase(activeIdx, p.name === 'linear' ? null : p.curve);
              }}
              title={`Ease this segment: ${p.name}`}
              aria-label={`Ease ${p.name}`}
              aria-pressed={presetOfActive === p.name}
            >
              <PresetGlyph curve={p.curve} />
            </Button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={prevFrame === null}
            onClick={() => prevFrame !== null && setPlayhead(prevFrame)}
            title={`Go to the previous ${label} keyframe`}
            aria-label={`Previous ${label} keyframe`}
          >
            <ChevronLeft size={12} />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={nextFrame === null}
            onClick={() => nextFrame !== null && setPlayhead(nextFrame)}
            title={`Go to the next ${label} keyframe`}
            aria-label={`Next ${label} keyframe`}
          >
            <ChevronRight size={12} />
          </Button>
          <Button variant="ghost" size="icon-xs" onClick={onClose} title="Close the curve editor" aria-label="Close the curve editor">
            <X size={12} />
          </Button>
        </div>
      </div>

      {/* Plot */}
      <div
        ref={plotRef}
        className="relative min-h-0 flex-1 overflow-hidden"
        data-chroma-curve-plot={param}
      >
        {segments.length === 0 ? (
          <div className="text-text-secondary flex h-full items-center justify-center text-[11px]">
            {label} needs at least two keyframes before it has a curve to shape.
          </div>
        ) : (
          <>
            {/* Value labels, both ends — the reference's own `100.00`/`0.00`
                corners. `toFixed(2)` matches it and keeps the two labels the
                same width as the numbers change. */}
            <span className="text-text-secondary pointer-events-none absolute left-1 top-0 text-[10px]">
              {range.max.toFixed(2)}
            </span>
            <span className="text-text-secondary pointer-events-none absolute bottom-0 left-1 text-[10px]">
              {range.min.toFixed(2)}
            </span>

            {/* `currentColor` + a `text-*` token class, not `stroke-accent`/`fill-accent`
                utilities — the same convention `ClipFadeOverlay`'s own SVG uses,
                and the one that keeps every colour flowing from this app's
                `--color-*` vars (CLAUDE.md's one-token-source rule). */}
            <svg className="absolute inset-0 h-full w-full text-accent" aria-hidden>
              {/* Everything outside this clip's own span, dimmed. */}
              <rect x={0} y={0} width={Math.max(0, clipX0)} height="100%" fill="var(--color-bg-primary)" fillOpacity={0.6} />
              <rect x={Math.max(0, clipX1)} y={0} width="100%" height="100%" fill="var(--color-bg-primary)" fillOpacity={0.6} />

              {/* The playhead, so the curve reads against where you are. */}
              <line
                x1={startLeftPx + (playhead / fps) * pxPerSec - scrollLeft}
                x2={startLeftPx + (playhead / fps) * pxPerSec - scrollLeft}
                y1={0}
                y2="100%"
                stroke="currentColor"
                strokeOpacity={0.6}
                strokeWidth={1}
              />

              {/* Hold before the first key and after the last — the flat runs
                  the reference draws, and what both renderers actually do
                  outside a property's keyed range. */}
              {rects.length > 0 && (
                <>
                  <line x1={0} x2={rects[0].x0} y1={rects[0].y0} y2={rects[0].y0} stroke="currentColor" strokeWidth={1.5} />
                  <line
                    x1={rects[rects.length - 1].x1}
                    x2="100%"
                    y1={rects[rects.length - 1].y1}
                    y2={rects[rects.length - 1].y1}
                    stroke="currentColor"
                    strokeWidth={1.5}
                  />
                </>
              )}

              {rects.map((rect, i) => (
                <path
                  key={`seg-${segments[i].fromFrame}`}
                  d={segmentPath(rect, drawnEase(i))}
                  stroke="currentColor"
                  strokeOpacity={i === activeIdx ? 1 : 0.55}
                  strokeWidth={i === activeIdx ? 2 : 1.5}
                  fill="none"
                  data-chroma-curve-segment={i}
                />
              ))}

              {/* The active segment's two control handles, each tethered to
                  the keyframe it belongs to — the standard presentation, and
                  the one the reference uses. */}
              {activeIdx !== null &&
                rects[activeIdx] &&
                segmentHandlePoints(rects[activeIdx], drawnEase(activeIdx)).map((p, hi) => {
                  // Handle 1 is tethered to the segment's earlier keyframe,
                  // handle 2 to its later one — which is exactly what those
                  // two control points ARE.
                  const anchor = rects[activeIdx];
                  const ax = hi === 0 ? anchor.x0 : anchor.x1;
                  const ay = hi === 0 ? anchor.y0 : anchor.y1;
                  return (
                    <g key={`handle-${hi}`}>
                      <line x1={ax} y1={ay} x2={p.x} y2={p.y} stroke="currentColor" strokeOpacity={0.7} strokeWidth={1} strokeDasharray="2 2" />
                      {/* The visible dot… */}
                      <circle
                        cx={p.x}
                        cy={p.y}
                        r={HANDLE_DOT_R}
                        fill="var(--color-bg-primary)"
                        stroke="currentColor"
                        strokeWidth={1.5}
                        pointerEvents="none"
                      />
                      {/* …and its real, larger grab target, painted last so it
                          takes the press. Transparent rather than
                          `fill="none"`: `none` is not hit-testable at all,
                          which is precisely the mistake that would make this
                          look right and do nothing. */}
                      <circle
                        cx={p.x}
                        cy={p.y}
                        r={HANDLE_HIT_RADIUS_PX}
                        fill="transparent"
                        className={disabled ? undefined : 'cursor-grab'}
                        onPointerDown={startHandleDrag((hi + 1) as 1 | 2)}
                        data-chroma-curve-handle={hi + 1}
                      />
                    </g>
                  );
                })}

              {/* Keyframe dots. Every segment boundary plus the very last key
                  — clicking one selects the segment that STARTS there, which
                  is the segment that owns the curve you are about to edit. */}
              {rects.map((rect, i) => (
                <circle
                  key={`key-${segments[i].fromFrame}`}
                  cx={rect.x0}
                  cy={rect.y0}
                  r={KEY_DOT_R}
                  fill={i === activeIdx ? 'currentColor' : 'var(--color-text-secondary)'}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    setSelectedIdx(i);
                  }}
                  data-chroma-curve-key={segments[i].fromFrame}
                />
              ))}
              {rects.length > 0 && (
                <circle
                  cx={rects[rects.length - 1].x1}
                  cy={rects[rects.length - 1].y1}
                  r={KEY_DOT_R}
                  fill="var(--color-text-secondary)"
                  data-chroma-curve-key={segments[segments.length - 1].toFrame}
                />
              )}
            </svg>
          </>
        )}
      </div>
    </div>
  );
}

/** A preset's own shape, drawn at button size — the four glyphs in the
 *  reference's header strip. Traced by the same `segmentPath` the real curve
 *  uses, so the button genuinely previews the curve it applies rather than
 *  being four hand-drawn icons that could disagree with the constants. */
function PresetGlyph({ curve }: { curve: EaseCurve }) {
  const s = 12;
  return (
    <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} aria-hidden>
      <path
        d={segmentPath({ x0: 1, y0: s - 1, x1: s - 1, y1: 1 }, curve)}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
      />
    </svg>
  );
}
