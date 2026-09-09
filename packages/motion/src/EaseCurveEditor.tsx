/**
 * @apelles/motion — the real bezier curve/easing editor, Phase 5b's fourth
 * and final piece (`docs/notes/motion-keyframe-timeline-research.md` §4/§9:
 * "a curve/easing editor... closer to a color-picker than to the timeline
 * strip itself... could ship independently"). Replaces the generic
 * `kind:'json'` raw-`[x1,y1,x2,y2]`-textarea `InspectorPanel.tsx` used for
 * every key's `ease` field (`CAM2D_KEY_FIELDS`/`CAM3D_KEY_FIELDS`/
 * `LAYER_TRANSFORM_KEY_FIELDS`, D-159 §5) with a real draggable-handle
 * curve widget — the ONLY thing this pass changes about those key rows;
 * every other field in the same row (`at`/`x`/`y`/`zoom`/`pos`/`look`/…)
 * stays exactly as `KeyframeList`/`FieldControl` already render it.
 *
 * **Presentation precedent, checked directly rather than assumed** (the
 * task's own instruction): `FieldControl`'s `kind === 'color'` case — the
 * codebase's closest existing "pick a value via a small purpose-built
 * widget" control — renders INLINE, always visible, no popover/trigger
 * button, live-updating (a native `<input type="color">` fires `onChange`
 * continuously while its own picker is being dragged, and that already
 * reaches `onCommit` — hence `m.commit` — on every tick, per
 * `InspectorPanel.tsx`'s existing `onChange={m.commit}` wiring in
 * `MotionTab.tsx`). This widget matches that shape exactly: inline, no
 * popover, live-commits on every pointermove during a drag — the SAME
 * "continuous control commits live, no separate blur/release step"
 * convention this Inspector already has for `color`/`number`, not a new
 * one invented for this field. (The JSON fallback control's own defer-to-
 * blur behaviour is the deliberate EXCEPTION for free-typed text, not the
 * pattern to match — see `JsonFieldControl`'s own doc comment.)
 *
 * **The "unset" convention, matched exactly.** `FieldControl`'s own module
 * doc comment: "the input shows empty/unchecked, not a guessed default, so
 * it's clear the value is 'unset' vs. 'set to the same thing.'" A curve
 * widget can't show a blank square the way a text input shows blank text —
 * so an absent `ease` renders `easeCurve.ts`'s `DEFAULT_EASE`
 * (`design.ease.inOut`, the literal curve the manifest already renders
 * with today when `ease` is omitted — see that module's own doc comment)
 * in a visually MUTED/dashed style with an explicit "Not set — defaults to
 * Ease In Out" caption, rather than either a blank widget or an
 * indistinguishable-from-authored curve. Dragging a muted handle, or
 * clicking a preset, is what actually WRITES `ease` for the first time; a
 * "Clear" button (shown only once a value IS set) commits `undefined`,
 * mirroring `JsonFieldControl`'s own empty-textarea-clears-the-field
 * behaviour for this same field today.
 *
 * DOM/pointer-event wiring below is deliberately UNTESTED, per this
 * package's own established split (`MotionCanvasOverlay.tsx`'s own
 * precedent, restated by `canvasGeometry.ts`'s doc comment) — the
 * coordinate math it calls (`easeCurve.ts`) carries the real test floor.
 */
import { type PointerEvent as ReactPointerEvent } from 'react';
import {
  clampEaseCurve,
  curvePath,
  curveToPixel,
  DEFAULT_EASE,
  EASE_PRESETS,
  EASE_Y_MAX,
  EASE_Y_MIN,
  pixelToCurve,
  resolveEaseCurve,
  type EaseCurve,
} from './easeCurve';
import type { FieldSpec } from './propCatalog';

const WIDGET_SIZE = 148;
const HANDLE_RADIUS = 5;

const labelClass = 'block text-[10px] font-medium text-text-secondary mb-1';

/** One draggable control-point handle (`p1` or `p2`) plus the dashed
 *  tangent line from its own curve endpoint — `anchor` is `(0,0)` for `p1`,
 *  `(1,1)` for `p2`, matching every standard cubic-bezier-timing-function
 *  editor's own visual convention (a line from each fixed endpoint to its
 *  own control point shows the curve's tangent direction there).
 *  `colorClass` is a Tailwind text-color utility (`currentColor` drives
 *  both the line and the circle) so the two handles read as visually
 *  distinct without hardcoding hex — the same "use the theme token, not a
 *  literal color" convention the rest of this file's siblings follow. */
function Handle({
  point,
  anchor,
  muted,
  colorClass,
  onDrag,
}: {
  point: { x: number; y: number };
  anchor: { x: number; y: number };
  muted: boolean;
  colorClass: string;
  onDrag: (next: { x: number; y: number }) => void;
}) {
  const size = { w: WIDGET_SIZE, h: WIDGET_SIZE };
  const px = curveToPixel(point, size);
  const anchorPx = curveToPixel(anchor, size);

  const handleMove = (e: ReactPointerEvent<SVGCircleElement>) => {
    const svg = e.currentTarget.ownerSVGElement;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const local = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    onDrag(pixelToCurve(local, { w: rect.width, h: rect.height }));
  };

  return (
    <g className={colorClass}>
      <line
        x1={anchorPx.x}
        y1={anchorPx.y}
        x2={px.x}
        y2={px.y}
        stroke="currentColor"
        strokeOpacity={muted ? 0.25 : 0.5}
        strokeDasharray="2,2"
      />
      <circle
        cx={px.x}
        cy={px.y}
        r={HANDLE_RADIUS}
        fill={muted ? 'transparent' : 'currentColor'}
        stroke="currentColor"
        strokeWidth={1.5}
        strokeOpacity={muted ? 0.6 : 1}
        style={{ cursor: 'grab', touchAction: 'none' }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          handleMove(e);
        }}
        onPointerMove={(e) => {
          if (e.buttons !== 1) return;
          handleMove(e);
        }}
      />
    </g>
  );
}

/** The unit-square + curve chrome shared by both the "set" and "unset"
 *  render paths: the `x:0..1`/`y:0..1` unit-square outline (a visual
 *  reference for how far a curve is over/undershooting the plain unit
 *  square) and the curve path itself. */
function CurveCanvas({ curve, muted }: { curve: EaseCurve; muted: boolean }) {
  const size = { w: WIDGET_SIZE, h: WIDGET_SIZE };
  const unitTopLeft = curveToPixel({ x: 0, y: 1 }, size);
  const unitBottomRight = curveToPixel({ x: 1, y: 0 }, size);
  const path = curvePath(clampEaseCurve(curve), size);

  return (
    <svg
      width={WIDGET_SIZE}
      height={WIDGET_SIZE}
      viewBox={`0 0 ${WIDGET_SIZE} ${WIDGET_SIZE}`}
      className={['rounded border border-border-color bg-surface', muted ? 'text-text-secondary' : 'text-accent'].join(
        ' ',
      )}
    >
      {/* the unit square [0,1]x[0,1] — the "no overshoot" reference frame */}
      <rect
        x={unitTopLeft.x}
        y={unitTopLeft.y}
        width={unitBottomRight.x - unitTopLeft.x}
        height={unitBottomRight.y - unitTopLeft.y}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.15}
        className="text-text-secondary"
      />
      <path
        d={path}
        fill="none"
        stroke="currentColor"
        strokeOpacity={muted ? 0.55 : 1}
        strokeWidth={2}
        strokeDasharray={muted ? '4,3' : undefined}
      />
    </svg>
  );
}

/**
 * The real control for `propCatalog.ts`'s `kind: 'ease'` fields — dispatched
 * from `InspectorPanel.tsx`'s `FieldControl` exactly like `kind:'color'`/
 * `kind:'vec'` already are. `value` is the raw manifest value (`unknown`,
 * may be `undefined`/malformed — see `easeCurve.ts`'s `resolveEaseCurve`).
 */
export function EaseFieldControl({
  spec,
  value,
  onCommit,
}: {
  spec: FieldSpec;
  value: unknown;
  onCommit: (v: unknown) => void;
}) {
  const resolved = resolveEaseCurve(value);
  const isSet = resolved !== null;
  const curve = resolved ?? DEFAULT_EASE;
  const [x1, y1, x2, y2] = curve;

  const commit = (next: EaseCurve) => onCommit(next);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className={labelClass}>{spec.label}</span>
        {isSet && (
          <button
            type="button"
            className="text-[10px] text-text-secondary hover:text-red-400 hover:underline mb-1"
            onClick={() => onCommit(undefined)}
          >
            Clear
          </button>
        )}
      </div>

      {!isSet && <p className="text-[10px] text-text-secondary italic">Not set — defaults to Ease In Out.</p>}

      {/* `flex-wrap`: at the Inspector panel's own `minSize` (200px,
          `MotionTab.tsx`), the fixed-size curve widget plus a presets
          column don't both fit side by side — wrapping drops the presets
          onto their own full-width row below the curve rather than
          clipping or forcing horizontal scroll, the same "degrade the
          layout, don't break it" floor every other Inspector control
          already gets from the panel's own `overflow-y-auto`. */}
      <div className="flex flex-wrap gap-2 items-start">
        <div className="relative shrink-0" style={{ width: WIDGET_SIZE, height: WIDGET_SIZE }}>
          <CurveCanvas curve={curve} muted={!isSet} />
          <svg
            width={WIDGET_SIZE}
            height={WIDGET_SIZE}
            viewBox={`0 0 ${WIDGET_SIZE} ${WIDGET_SIZE}`}
            className="absolute inset-0"
          >
            <Handle
              point={{ x: x1, y: y1 }}
              anchor={{ x: 0, y: 0 }}
              muted={!isSet}
              colorClass="text-red-400"
              onDrag={(p) => commit([p.x, p.y, x2, y2])}
            />
            <Handle
              point={{ x: x2, y: y2 }}
              anchor={{ x: 1, y: 1 }}
              muted={!isSet}
              colorClass="text-accent"
              onDrag={(p) => commit([x1, y1, p.x, p.y])}
            />
          </svg>
        </div>
        <div className="flex flex-col gap-1 flex-1 min-w-0">
          <span className="text-[9px] text-text-secondary/70">Presets</span>
          <div className="flex flex-col gap-1">
            {EASE_PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                className="h-6 px-2 rounded border border-border-color text-[10px] text-text-primary text-left hover:border-accent hover:text-accent"
                onClick={() => commit(preset.value)}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <span className="text-[9px] text-text-secondary/60 font-mono">
        [{x1.toFixed(2)}, {y1.toFixed(2)}, {x2.toFixed(2)}, {y2.toFixed(2)}]
      </span>
      <p className="text-[9px] text-text-secondary/50">
        Widget range: x 0–1, y {EASE_Y_MIN}–{EASE_Y_MAX} (drag beyond it clamps — edit the manifest JSON directly for a
        more extreme curve).
      </p>
    </div>
  );
}
