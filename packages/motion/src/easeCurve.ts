/**
 * @chroma/motion — pure math for `EaseCurveEditor.tsx`'s bezier curve widget
 * (Phase 5b, part 4 — "a curve/easing editor," the last of the four pieces
 * `docs/notes/motion-keyframe-timeline-research.md` §4 named for Phase 5b:
 * "Every key already carries an optional `ease`... editable today only as
 * JSON text... A real bezier-curve-with-draggable-handles editor is a
 * genuinely separate, self-contained UI component").
 *
 * **The 4-tuple's own meaning, confirmed against `remotion`'s real source
 * this pass, not assumed.** Every key's `ease` (`schema.ts`'s `EaseCurve`,
 * `[x1,y1,x2,y2]`) is fed straight to `Easing.bezier(x1,y1,x2,y2)`
 * (`interpolateKeys.ts`), which — read directly at
 * `node_modules/remotion/dist/cjs/easing.d.ts` and `.../bezier.js` this
 * pass — is a thin wrapper over a `bezier(mX1,mY1,mX2,mY2)` helper lifted
 * from React Native's own Animated library. `p1=(x1,y1)` and `p2=(x2,y2)`
 * are the two INTERIOR control points of a standard cubic bezier running
 * from a fixed `(0,0)` to a fixed `(1,1)` — exactly the CSS
 * `cubic-bezier()` timing-function convention, confirmed rather than
 * guessed.
 *
 * **A real, load-bearing constraint found while confirming that, not a
 * cosmetic choice:** `bezier.js`'s own `bezier()` THROWS
 * (`'bezier x values must be in [0, 1] range'`) unless `0 <= mX1,mX2 <= 1`
 * — so this widget's drag math MUST clamp an `x` handle to `[0,1]`; letting
 * it go negative or past `1` would not just look wrong, it would crash the
 * render the moment that key is reached. `y1`/`y2` carry no such
 * constraint at all — `design.ease.anticipate` (`motion-engine/src/
 * design.ts`, already shipping) overshoots to `y1:-0.55`/`y2:1.55` — so the
 * widget's own vertical viewport is deliberately taller than the unit
 * square (`EASE_Y_MIN`/`EASE_Y_MAX` below) to give an overshoot curve room
 * to be seen and grabbed, not clamp it away.
 *
 * **The rendered curve needs no numerical bezier evaluation at all** — the
 * other real design question this module answers rather than assumes.
 * `Easing.bezier`'s own `calcBezier(t, a1, a2)` (`bezier.js`) evaluates the
 * SAME parametric cubic bezier `(bezierX(t), bezierY(t))` for `t` in
 * `[0,1]` that an SVG `<path d="M0,0 C x1,y1 x2,y2 1,1">` already draws
 * natively — so `curvePath` below is a coordinate transform and a string
 * template, not an approximation of the real curve: it IS the real curve,
 * mathematically, not merely similar-looking.
 *
 * Kept apart from `EaseCurveEditor.tsx` for the same `vitest`
 * `node`-environment reason every other pure-math module in this package
 * is split from its DOM component (`canvasGeometry.ts`'s own doc comment)
 * — the pointer↔curve-value conversion (`pixelToCurve`) is exactly the
 * "getting this wrong is silent" class of bug that split exists to guard
 * against: a curve that LOOKS right on screen but silently reports the
 * wrong `[x1,y1,x2,y2]` to the manifest would render a visibly different
 * animation than what the widget appeared to show.
 */
import { design } from '@chroma/motion-engine/src/design';

/** The same 4-tuple shape as `schema.ts`'s own exported `EaseCurve`
 *  (`z.infer` of a `z.tuple` of four numbers, so MUTABLE there) — declared
 *  locally as `readonly` instead of imported, deliberately: every value
 *  this module actually receives (a manifest's own `ease` field, or one of
 *  `design.ease.*`'s own `as const` presets, which ARE readonly tuples of
 *  literal numbers) is happily assignable to a `readonly` parameter either
 *  way, while the reverse (a `readonly` design-token preset assigned to a
 *  MUTABLE local type) is not — matching `interpolateKeys.ts`'s own
 *  `fallbackEase: readonly [...]` parameter shape rather than fighting it. */
export type EaseCurve = readonly [number, number, number, number];

export interface CurvePoint {
  x: number;
  y: number;
}

export interface PixelSize {
  w: number;
  h: number;
}

/**
 * The widget's own vertical viewport, in curve-value units — NOT a schema
 * bound (`schema.ts` places no limit on `ease`'s y values at all) and
 * deliberately wider than `[0,1]` so `design.ease.anticipate`'s own
 * `y1:-0.55`/`y2:1.55` sit comfortably inside it, with room to grab the
 * handle, rather than flush against the widget's own edge. **A disclosed
 * widget-only limit, not a hidden one:** a curve needing a MORE extreme
 * overshoot than this can still be authored by hand-editing the manifest
 * text (every other JSON-shaped Inspector field already accepts anything
 * the schema does) — this widget's own drag range is chosen for what's
 * legible and grabbable in a sidebar-width Inspector panel, not for
 * covering every mathematically possible curve.
 */
export const EASE_Y_MIN = -0.75;
export const EASE_Y_MAX = 1.75;

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Curve-value space (`x` in `[0,1]`, `y` in `[EASE_Y_MIN,EASE_Y_MAX]`) →
 *  pixel space (`x` in `[0,w]`, `y` in `[0,h]`, SVG's own y-DOWN
 *  convention — `y:1` sits near pixel-row `0` at the TOP, `y:0` sits near
 *  the bottom, matching every other bezier-curve-editor's own visual
 *  convention: the curve rises left-to-right). `size.w`/`size.h` of `0`
 *  (not yet measured) collapses everything to the origin rather than
 *  dividing by zero. */
export function curveToPixel(p: CurvePoint, size: PixelSize): CurvePoint {
  const yRange = EASE_Y_MAX - EASE_Y_MIN;
  return {
    x: p.x * size.w,
    y: size.h - ((p.y - EASE_Y_MIN) / yRange) * size.h,
  };
}

/** The inverse of `curveToPixel` — a pointer position, already made
 *  LOCAL to the widget's own bounding box (the one real DOM measurement
 *  this feature needs, taken in `EaseCurveEditor.tsx` via
 *  `getBoundingClientRect()`, the same "measure fresh, don't re-derive"
 *  convention `canvasGeometry.ts`'s own `screenToWorld` already uses) →
 *  the curve-value point a drag should commit. **Clamps `x` to `[0,1]`
 *  unconditionally** — `Easing.bezier`'s own hard requirement, this
 *  module's own doc comment above — and clamps `y` to
 *  `[EASE_Y_MIN,EASE_Y_MAX]`, the widget's own disclosed visual range. A
 *  drag can never produce a value that would crash the render, by
 *  construction, not by a caller remembering to check. */
export function pixelToCurve(p: CurvePoint, size: PixelSize): CurvePoint {
  const yRange = EASE_Y_MAX - EASE_Y_MIN;
  const rawX = size.w > 0 ? p.x / size.w : 0;
  const rawY = size.h > 0 ? EASE_Y_MIN + (1 - p.y / size.h) * yRange : EASE_Y_MIN;
  return { x: clamp(rawX, 0, 1), y: clamp(rawY, EASE_Y_MIN, EASE_Y_MAX) };
}

/** Defends the widget against a curve value that got INTO the manifest
 *  some other way (hand-edited JSON, an older/foreign tool) with `x1`/`x2`
 *  outside `[0,1]` — the one shape that would otherwise crash
 *  `Easing.bezier` at render time. Clamped for DISPLAY/DRAG purposes only;
 *  this module never writes a clamped value back on its own — only an
 *  actual drag or preset click commits anything (see `EaseCurveEditor.tsx`). */
export function clampEaseCurve(curve: EaseCurve): EaseCurve {
  return [
    clamp(curve[0], 0, 1),
    clamp(curve[1], EASE_Y_MIN, EASE_Y_MAX),
    clamp(curve[2], 0, 1),
    clamp(curve[3], EASE_Y_MIN, EASE_Y_MAX),
  ];
}

/** Validates a raw manifest value (`unknown` — the same trust boundary
 *  every `FieldControl` value crosses) is a genuine 4-tuple of finite
 *  numbers before the widget trusts it as an `EaseCurve`. `null` for
 *  anything else (not a 4-length array, a non-number element, `NaN`/
 *  `Infinity`) — the caller's cue to render the "unset" state, the same
 *  as `undefined` — rather than letting a malformed value reach
 *  `clampEaseCurve`/`curveToPixel` and produce a nonsensical curve. */
export function resolveEaseCurve(raw: unknown): EaseCurve | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  if (!raw.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  return raw as unknown as EaseCurve;
}

/**
 * The SVG path for the curve from `(0,0)` to `(1,1)` through control
 * points `p1=(x1,y1)`/`p2=(x2,y2)` — a single cubic-bezier `C` command, no
 * numeric easing evaluation (see this module's own doc comment for why
 * that's exact, not an approximation).
 */
export function curvePath(curve: EaseCurve, size: PixelSize): string {
  const [x1, y1, x2, y2] = curve;
  const p0 = curveToPixel({ x: 0, y: 0 }, size);
  const c1 = curveToPixel({ x: x1, y: y1 }, size);
  const c2 = curveToPixel({ x: x2, y: y2 }, size);
  const p3 = curveToPixel({ x: 1, y: 1 }, size);
  return `M ${p0.x} ${p0.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p3.x} ${p3.y}`;
}

export interface EasePreset {
  label: string;
  value: EaseCurve;
}

/**
 * Quick-select presets — the task's own instruction: "linear, ease-in,
 * ease-out, ease-in-out, and whatever `design.ease.*` already defines,"
 * checked against that module's REAL exports (`motion-engine/src/
 * design.ts`) rather than inventing a parallel set. `design.ease` only
 * defines `out`/`inOut`/`anticipate` (no plain `in`) — `Linear` and
 * `Ease In` are the two standard CSS curves this engine has never needed a
 * named token for; `Ease Out`/`Ease In Out`/`Anticipate` are `design.ease`'s
 * own values, referenced directly (not retyped as literals) so this list
 * can never silently drift from the engine's own tokens.
 */
export const EASE_PRESETS: EasePreset[] = [
  { label: 'Linear', value: [0, 0, 1, 1] },
  { label: 'Ease In', value: [0.42, 0, 1, 1] },
  { label: 'Ease Out', value: design.ease.out },
  { label: 'Ease In Out', value: design.ease.inOut },
  { label: 'Anticipate', value: design.ease.anticipate },
];

/**
 * The curve shown — and used as the drag/preset starting point — when a
 * key's `ease` is absent. **Not an arbitrary widget-only guess:** it is
 * the literal curve `interpolateKeys.ts`'s own `fallbackEase` argument
 * already resolves to at BOTH of its real call sites today
 * (`manifestEdit.ts`'s `layerTransformKeyDelta` and, per D-159's own
 * write-up, `Camera.tsx`/`Video.tsx`'s renders) — `design.ease.inOut`. So
 * "not yet set, defaults to Ease In Out" (the Inspector's own label, see
 * `EaseCurveEditor.tsx`) is a statement of FACT about what the manifest
 * already renders, not a widget convenience.
 */
export const DEFAULT_EASE: EaseCurve = design.ease.inOut;
