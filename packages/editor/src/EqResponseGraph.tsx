/**
 * @chroma/editor — the Inspector's EQ response graph (D-237, roadmap item 27
 * "EQ response curve UI" — the half of D-224's per-clip parametric EQ that was
 * deliberately deferred).
 *
 * What it is: Resolve's own ±24 dB / log-frequency Clip Equalizer plot
 * (`scratch/resolve-reference/soundtrack.jpg`), built above the four band
 * blocks D-224 already shipped rather than replacing them — a numbered,
 * draggable point per band, hit-tested and hand-dragged in real screen space,
 * plus the whole strip's own combined response drawn as a filled/stroked
 * line. Every dB number on screen comes from `eqResponseDb` (`./eq`, D-224's
 * pinned math) via `eqCurve.ts`'s pure sampling/screen-mapping — nothing here
 * re-derives a biquad.
 *
 * What it does NOT do:
 *   - It does not replace the Freq/Gain/Q `PropertyRow`s below it. Those stay
 *     the precise, typeable way to set an exact number; this is the "see and
 *     feel" affordance Resolve's own graph is, and the two write the SAME
 *     `onBandChange` callback, so a drag and a typed value can never disagree
 *     about what "band 2" means.
 *   - It does not keyframe anything — D-224's own EQ-is-static decision is
 *     unaffected; there is nothing time-varying to show or drag here.
 *   - It does not draw a Q handle. Q is scroll-wheel-over-the-point
 *     (`eqQAfterWheel`'s own doc has the real precedent this was checked
 *     against) rather than a second draggable control, because Resolve's own
 *     reference shows no secondary axis on its points at all and inventing one
 *     would be a new gesture with no reference behind it.
 *
 * **Drag/commit follows this package's own established convention**
 * (`ClipCurveEditor.tsx`'s bezier handles, `ClipFadeOverlay`'s fade handles,
 * `TransformOverlay`'s transform box): live, overlay-only feedback during the
 * gesture (`draft`, a ref-backed drag record so the window listeners below
 * never need rebinding mid-drag), exactly ONE `onBandChange` call on
 * pointer-up, nothing committed by a drag that ends where it began, Escape
 * cancels. This matters here for the same reason it does everywhere else in
 * this package: `set_clip_eq` — like every `applyOp` — snapshots the whole
 * timeline per call, so a per-pointermove commit would be one undo entry per
 * pixel of mouse movement instead of one per real edit.
 *
 * **The scroll-wheel Q gesture gets its own short debounce**, unlike the
 * pointer drag's pure "commit on release": a wheel gesture has no discrete
 * "release" event (a trackpad can fire dozens of `wheel` events for one
 * finger swipe), so committing on every event would flood the undo stack the
 * exact way a per-pointermove commit would. A brief idle timer
 * (`EQ_Q_WHEEL_COMMIT_MS`) collapses a whole scroll gesture into the same one
 * commit the pointer drag gets, using the identical live-draft-then-commit
 * shape.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { eqKindUsesGain, type EqBand } from './eq';
import {
  EQ_DB_GRIDLINES,
  EQ_FREQ_GRIDLINES,
  eqBandPoint,
  eqCurveFillPath,
  eqCurveLinePath,
  eqCurveSamples,
  eqPointDragPatch,
  eqQAfterWheel,
  freqToX,
  dbToY,
} from './eqCurve';

/** The graph's own fixed height, px. Not independently resizable
 *  (CLAUDE.md's resizable-pane rule is about panes a user drags to see more
 *  content — this is a small, fixed-proportion readout inside the Inspector's
 *  own scrolling column, the same posture every other EQ row already has, and
 *  Resolve's own graph is a fixed height in its Inspector too). */
const GRAPH_HEIGHT_PX = 92;

/** A band's own point radius, and the larger transparent hit target around it
 *  — the same split `ClipCurveEditor.tsx`'s `HANDLE_DOT_R`/
 *  `HANDLE_HIT_RADIUS_PX` use, for the identical reason: a 4px dot is legible,
 *  but a 4px-radius hit area is nearly impossible to land a real pointer on. */
const POINT_R = 4.5;
const POINT_HIT_RADIUS_PX = 11;

/** How long a scroll gesture may sit idle before its Q change commits — see
 *  the module doc. Long enough to bridge the gap between two `wheel` events
 *  in one real trackpad gesture, short enough that lifting the mouse off the
 *  wheel doesn't feel like it left the edit in limbo. */
const EQ_Q_WHEEL_COMMIT_MS = 250;

/** The in-flight pointer drag — a ref, not state, for the same reason
 *  `ClipCurveEditor.tsx`'s `HandleDrag` is: the window listeners below are
 *  bound once per gesture and must see live values without being torn down
 *  and rebuilt on every pointermove. */
interface PointDrag {
  pointerId: number;
  index: number;
  startFreq: number;
  startGain: number;
  usesGain: boolean;
}

export interface EqResponseGraphProps {
  /** This clip's own bands for DISPLAY — `eqBandsForDisplay`'s result, so the
   *  graph always shows the same four points the band blocks below it show,
   *  materialised strip or not. */
  bands: readonly EqBand[];
  /** A locked track's graph is drawn but not draggable — the same posture
   *  every other EQ control here takes. */
  disabled: boolean;
  /** The rate the curve is drawn at. Defaults to the exporter's own design
   *  rate (`EQ_DESIGN_SAMPLE_RATE`) via `eqCurveSamples`'s own default, which
   *  is what an agent reading `editor_set_clip_eq`'s `responseDb` also sees —
   *  the GUI and the MCP tool report the same curve. */
  sampleRate?: number;
  /** Patch ONE band — the exact shape `ClipInspectorPanel`'s own
   *  `onEqBandChange` already is, so a drag here and a typed `PropertyRow`
   *  value write through the identical callback. */
  onBandChange: (band: number, patch: Partial<EqBand>) => void;
}

export function EqResponseGraph({ bands, disabled, sampleRate, onBandChange }: EqResponseGraphProps) {
  const plotRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<PointDrag | null>(null);
  const qTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [size, setSize] = useState({ width: 0, height: GRAPH_HEIGHT_PX });
  const [draft, setDraft] = useState<{ index: number; patch: Partial<EqBand> } | null>(null);
  const [dragging, setDragging] = useState(false);
  /** The uncommitted Q of an in-flight wheel gesture. Separate from `draft`
   *  because a wheel gesture and a pointer drag are different interactions
   *  that can never target the same band at once, but keeping them as two
   *  pieces of state (rather than overloading one) means neither has to guess
   *  which kind of gesture produced it. */
  const [qDraft, setQDraft] = useState<{ index: number; q: number } | null>(null);

  // The plot's own box, measured rather than assumed — the Inspector column's
  // width varies with the app window, and unlike `ClipCurveEditor`'s lane this
  // has no external pxPerSec to borrow, so it owns a `ResizeObserver` the same
  // way that component's plot does.
  useEffect(() => {
    const el = plotRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setSize({ width: el.clientWidth, height: el.clientHeight || GRAPH_HEIGHT_PX }));
    ro.observe(el);
    setSize({ width: el.clientWidth, height: el.clientHeight || GRAPH_HEIGHT_PX });
    return () => ro.disconnect();
  }, []);

  useEffect(
    () => () => {
      if (qTimerRef.current) clearTimeout(qTimerRef.current);
    },
    [],
  );

  /** The bands actually DRAWN: `bands` with an in-flight wheel's Q applied,
   *  then an in-flight drag's freq/gain applied on top — so the curve and the
   *  dragged point's own position always reflect exactly what the user is
   *  doing right now, not what was last committed. */
  const drawnBands = useMemo(() => {
    let next = bands;
    if (qDraft) {
      next = next.map((b, i) => (i === qDraft.index ? { ...b, q: qDraft.q } : b));
    }
    if (draft) {
      next = next.map((b, i) => (i === draft.index ? { ...b, ...draft.patch } : b));
    }
    return next;
  }, [bands, qDraft, draft]);

  const samples = useMemo(
    () => eqCurveSamples(drawnBands, size.width, size.height, sampleRate),
    [drawnBands, size.width, size.height, sampleRate],
  );
  const linePath = eqCurveLinePath(samples);
  const fillPath = eqCurveFillPath(samples, size.height);

  // ------------------------------------------------------------------ //
  // pointer drag: freq (x) + gain (y, gain-using kinds only)
  // ------------------------------------------------------------------ //

  const startDrag = (index: number) => (e: React.PointerEvent<SVGCircleElement>) => {
    if (disabled) return;
    e.stopPropagation();
    const band = bands[index];
    dragRef.current = {
      pointerId: e.pointerId,
      index,
      startFreq: band.freq_hz,
      startGain: band.gain_db,
      usesGain: eqKindUsesGain(band.kind),
    };
    setDraft({
      index,
      patch: eqKindUsesGain(band.kind) ? { freq_hz: band.freq_hz, gain_db: band.gain_db } : { freq_hz: band.freq_hz },
    });
    setDragging(true);
  };

  useEffect(() => {
    if (!dragging) return;
    const finish = () => {
      dragRef.current = null;
      setDraft(null);
      setDragging(false);
    };

    const patchAt = (clientX: number, clientY: number, g: PointDrag): Partial<EqBand> => {
      const box = plotRef.current?.getBoundingClientRect();
      if (!box) return {};
      return eqPointDragPatch(bands[g.index], size.width, size.height, clientX - box.left, clientY - box.top);
    };

    const onMove = (e: PointerEvent) => {
      const g = dragRef.current;
      if (!g || e.pointerId !== g.pointerId) return;
      setDraft({ index: g.index, patch: patchAt(e.clientX, e.clientY, g) });
    };

    const onUp = (e: PointerEvent) => {
      const g = dragRef.current;
      if (!g || e.pointerId !== g.pointerId) return;
      const next = patchAt(e.clientX, e.clientY, g);
      finish();
      // A drag that ends where it began commits nothing — one undo entry per
      // real change, never per gesture, matching `ClipCurveEditor`'s own rule.
      const freqChanged = next.freq_hz !== undefined && next.freq_hz !== g.startFreq;
      const gainChanged = g.usesGain && next.gain_db !== undefined && next.gain_db !== g.startGain;
      if (!freqChanged && !gainChanged) return;
      onBandChange(g.index, next);
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
  }, [dragging, bands, size.width, size.height, onBandChange]);

  // ------------------------------------------------------------------ //
  // scroll wheel: Q
  // ------------------------------------------------------------------ //

  const onWheelAt = (index: number) => (e: React.WheelEvent<SVGCircleElement>) => {
    if (disabled) return;
    e.preventDefault();
    e.stopPropagation();
    const base = qDraft && qDraft.index === index ? qDraft.q : bands[index].q;
    const nextQ = eqQAfterWheel(base, e.deltaY);
    setQDraft({ index, q: nextQ });
    if (qTimerRef.current) clearTimeout(qTimerRef.current);
    // `nextQ` is captured directly here rather than re-read from state inside
    // the timeout — React 18 StrictMode double-invokes a functional `setState`
    // updater to check it is pure, so committing `onBandChange` as a side
    // effect INSIDE one (the first shape this took) fires it twice in dev.
    // Closing over the plain value sidesteps that entirely, and is simpler
    // besides: there is nothing to "re-read", the value this timer is FOR is
    // already known.
    qTimerRef.current = setTimeout(() => {
      qTimerRef.current = null;
      if (nextQ !== bands[index].q) onBandChange(index, { q: nextQ });
      setQDraft(null);
    }, EQ_Q_WHEEL_COMMIT_MS);
  };

  return (
    <div
      ref={plotRef}
      className="relative w-full overflow-hidden rounded border border-border-color bg-bg-primary/40"
      style={{ height: GRAPH_HEIGHT_PX }}
      data-chroma-eq-graph
    >
      {size.width > 0 && (
        <svg
          className="absolute inset-0 h-full w-full text-accent"
          role="img"
          aria-label="Combined EQ response curve"
        >
          {EQ_DB_GRIDLINES.map((db) => (
            <line
              key={`db-${db}`}
              x1={0}
              x2="100%"
              y1={dbToY(db, size.height)}
              y2={dbToY(db, size.height)}
              stroke="var(--color-border-color)"
              strokeWidth={db === 0 ? 1 : 0.5}
              strokeOpacity={db === 0 ? 0.8 : 0.4}
            />
          ))}
          {EQ_FREQ_GRIDLINES.map((hz) => (
            <line
              key={`hz-${hz}`}
              x1={freqToX(hz, size.width)}
              x2={freqToX(hz, size.width)}
              y1={0}
              y2="100%"
              stroke="var(--color-border-color)"
              strokeWidth={0.5}
              strokeOpacity={0.35}
            />
          ))}

          <path d={fillPath} fill="currentColor" fillOpacity={0.12} stroke="none" data-chroma-eq-fill />
          <path d={linePath} fill="none" stroke="currentColor" strokeWidth={1.5} data-chroma-eq-curve />

          {drawnBands.map((band, i) => {
            const p = eqBandPoint(band, size.width, size.height);
            return (
              <g key={i}>
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={POINT_R}
                  fill="var(--color-bg-primary)"
                  stroke="currentColor"
                  strokeOpacity={band.enabled ? 1 : 0.4}
                  strokeWidth={1.5}
                  pointerEvents="none"
                />
                <text
                  x={p.x}
                  y={p.y}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={7}
                  fill="currentColor"
                  fillOpacity={band.enabled ? 1 : 0.4}
                  pointerEvents="none"
                >
                  {i + 1}
                </text>
                {/* The real, larger grab/scroll target, painted last so it
                    takes the press/wheel — the same transparent-not-`none`
                    convention `ClipCurveEditor.tsx`'s own handle circles use
                    (`none` is not hit-testable at all). */}
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={POINT_HIT_RADIUS_PX}
                  fill="transparent"
                  className={disabled ? undefined : 'cursor-grab'}
                  onPointerDown={startDrag(i)}
                  onWheel={onWheelAt(i)}
                  data-chroma-eq-point={i}
                />
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}
