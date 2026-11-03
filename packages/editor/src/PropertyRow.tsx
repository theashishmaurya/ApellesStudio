/**
 * @apelles/editor — one keyframeable Inspector row: label, numeric field,
 * per-property keyframe nav (`<`/`>`), the stopwatch diamond, and a reset
 * (D-208, extracted from `ClipInspectorPanel.tsx` as its own reusable
 * component — roadmap 25, "foundational, unblocks the rest").
 *
 * **Why this was worth extracting, and why not further than this.**
 * `ClipInspectorPanel.tsx`'s own module doc already settled the real
 * question here once (D-103): Motion's `InspectorPanel.tsx` and Colorist's
 * `ControlsPanel` are each tab's own panel, with their own field layout,
 * built for different content (wider panels, selects/colour-pickers, not
 * this panel's narrow side-by-side numeric rows) — forcing all three into
 * one shared component across tab boundaries would mean rewriting two
 * working, tested layouts for no real gain, exactly the over-unification
 * `@apelles/inspector`'s own README warns against. What actually IS shared,
 * and was worth pulling out, is narrower and real: every new keyframeable
 * numeric property this tab adds — the Transform/Crop rows already here,
 * and the per-clip audio pan/volume and EQ rows still to come — needs the
 * identical diamond/nav/reset behaviour `PropertyRow` already implements
 * once, correctly, with its own real tests. Duplicating that logic into a
 * second near-identical component per new section would be the copy-paste
 * this repo's own "shared logic -> extract, don't copy" rule exists to
 * prevent; extracting the ALREADY-shared row into its own file, generic
 * over its param's name, is what lets the next feature reuse it instead.
 *
 * **Generalised over `TParam extends string`, not pinned to
 * `ClipTransformParam`.** The original inline version typed `param` as
 * `ClipTransformParam` — the closed union of the nine transform/crop field
 * names — which would have made this component unusable for anything
 * outside that set (an audio pan row, an EQ band gain). The row itself
 * never inspects `param`'s value; it only ever hands it back verbatim to
 * the three callbacks, so a generic type parameter costs nothing and
 * removes the coupling. `ClipInspectorPanel.tsx`'s own usage sites still
 * get the exact same `ClipTransformParam`-typed callbacks they had before
 * — TypeScript infers `TParam` from the `state`/callbacks passed in, so
 * nothing at either existing call site changed shape.
 *
 * **D-432 (P4) — the row is `InspectorRow` + `InspectorNumber`.** The label
 * column (92 px, full text, ellipsis only past that), the value control and a
 * **fixed 80 px keyframe slot** come from `@apelles/ui`'s `InspectorRow`, so no
 * row carries its own widths and nothing shifts on hover or when a property
 * becomes animated: the slot always takes its width and its buttons fade with
 * `opacity`. The value is a `NumberScrubber` (drag to scrub, click to type,
 * arithmetic) through `InspectorNumber`, which folds a scrub's per-frame ops
 * into one undo step. B-113 / D-253's concerns (digits fitting, no native
 * spinner) are the scrubber's own now; `numericField.ts` keeps their history.
 *
 * **v0.3.0 (B-359 item 2): inline sliders and paired rows.** A row given a
 * `slider` span renders `InspectorSliderField` (a slider beside the field,
 * one undo step per drag), as the approved mockup draws Scale, Rotation and
 * Opacity. `PairedPropertyRow` puts two properties on one row (Position X /
 * Y) behind ONE keyframe slot, Final Cut's single Position parameter: the
 * diamond animates or stops both, ‹ › walk the union of their keys, ↺
 * resets both, each multi-op action one undo step.
 *
 * Pure presentation, like the panel it came from: no store access beyond the
 * undo bracket (`InspectorNumber`, and the paired row's two-op actions), no
 * `Clip` knowledge, nothing beyond the props below.
 */
import {
  CaretLeftIcon,
  CaretRightIcon,
  DiamondIcon,
  ArrowCounterClockwiseIcon,
  BezierCurveIcon,
} from '@phosphor-icons/react';
import { InspectorRow } from '@apelles/ui';

import { beginHistoryGroup, endHistoryGroup } from './timelineStore';
import { InspectorNumber, InspectorSliderField } from './InspectorNumber';

/** One keyframe-slot button: 16 px, so ‹ ◇ › ∿ ↺ fit the 80 px slot. */
const SLOT_BUTTON =
  'flex size-4 shrink-0 items-center justify-center rounded-sm text-text-tertiary hover:bg-card-active hover:text-text-primary disabled:pointer-events-none disabled:opacity-30';
/** Shown on row hover / keyboard focus inside the row, otherwise transparent —
 *  `opacity` costs no layout, so the slot never shifts (D-432). */
const ON_ROW_ACTIVE = 'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100';

/** One keyframeable property's live state, as a `PropertyRow` needs it —
 *  generic over nothing (a value is always a plain number here; a
 *  non-numeric property, e.g. a curve preset, is a different kind of row
 *  entirely and stays out of this component's scope). `EditorInspectorPanel`
 *  derives every field via `paramValueAt`; nothing in this component reads
 *  `Clip.chroma_keyframes` directly.
 *
 *  `value` is the property's value AT THE PLAYHEAD — the interpolated one
 *  for an animated property, the static field otherwise — because a field
 *  showing a static number while the preview renders an interpolated one
 *  is a row that lies about the picture. */
export interface PropertyState {
  value: number;
  /** Any keyframe at all names this property (the filled diamond). */
  animated: boolean;
  /** …and one of them sits exactly at the playhead. */
  keyedHere: boolean;
  /** The nearest key strictly before / after the playhead, or `null` when
   *  there is none in that direction (the `<` / `>` buttons' disabled state).
   *  Timeline frames, ready to hand straight to `setPlayhead`. */
  prevFrame: number | null;
  nextFrame: number | null;
}

/** A [`PropertyState`] for a property this app deliberately does NOT keyframe
 *  — D-224's EQ band fields, whose static-only-ness is a stated design call
 *  (ffmpeg's biquad filters parse their parameters once, so an animated EQ is
 *  not expressible in the export at all, and a preview that did what the
 *  export cannot is the defect class this repo keeps closing). The value, and
 *  every keyframe flag at rest.
 *
 *  Paired with **omitting** `onKeyframeToggle`/`onKeyframeNav`, which is what
 *  makes the row render with no diamond and no nav arrows rather than with
 *  three dead ones. A static row still wants everything else this component
 *  already gets right — the label/field layout, the disabled handling, and its
 *  own reset — which is precisely why it reuses this row instead of growing a
 *  second near-identical one, this file's own reason for existing. */
export function staticPropertyState(value: number): PropertyState {
  return { value, animated: false, keyedHere: false, prevFrame: null, nextFrame: null };
}

/** One Transform/Crop-shaped row: label, value, and a fixed keyframe slot
 *  (‹ prev, ◇ toggle, › next, ∿ curve, ↺ reset — D-208, D-233, D-432).
 *
 *  `TParam` is whatever the caller's own property-name type is
 *  (`ClipTransformParam` for the Transform/Crop/Audio rows, an EQ band's own
 *  field name for D-224's) — this component never inspects the value, only
 *  passes it back to the callbacks, so it stays correct for a param type it
 *  has never seen.
 *
 *  **The keyframe controls are optional** (D-224): pass neither
 *  `onKeyframeToggle` nor `onKeyframeNav` and the ‹ ◇ › trio is not rendered
 *  at all (the slot still holds the reset). That is for a property that
 *  genuinely cannot be animated — three permanently-disabled buttons would
 *  advertise an affordance that does not exist. `onReset` stays required
 *  either way: every property here has a rest value. */
/** The ‹ ◇ › ∿ ↺ slot, shared by the single and the paired row. */
function KeyframeSlot({
  label,
  animated,
  keyedHere,
  hasPrev,
  hasNext,
  disabled,
  onToggle,
  onNav,
  onReset,
  onOpenCurve,
  curveOpen,
}: {
  label: string;
  animated: boolean;
  keyedHere: boolean;
  hasPrev: boolean;
  hasNext: boolean;
  disabled: boolean;
  /** Omitted (with `onNav`) for a property that cannot be animated. */
  onToggle?: () => void;
  onNav?: (dir: -1 | 1) => void;
  onReset: () => void;
  onOpenCurve?: () => void;
  curveOpen: boolean;
}) {
  // Both together or neither — a row with nav arrows but no diamond (or the
  // reverse) is not a state any caller wants.
  const keyframeable = !!onToggle && !!onNav;
  return (
    <>
      {keyframeable && (
        <>
          <button
            type="button"
            className={`${SLOT_BUTTON} ${animated ? '' : 'invisible'}`}
            disabled={disabled || !hasPrev}
            onClick={() => onNav?.(-1)}
            title={`Go to the previous ${label} keyframe`}
            aria-label={`Previous ${label} keyframe`}
          >
            <CaretLeftIcon size={11} />
          </button>
          <button
            type="button"
            disabled={disabled}
            // Keyed at the playhead reads in the selection colour; animated but
            // between keys is the same hue dimmed; static is hidden until the
            // row is hovered or focused. That is the whole reason ‹ › mean
            // anything — the row says whether the playhead sits on a key.
            className={`${SLOT_BUTTON} ${animated ? (keyedHere ? 'text-selection' : 'text-selection/60') : ON_ROW_ACTIVE}`}
            onClick={() => onToggle?.()}
            title={
              animated
                ? `Stop animating ${label} (removes its keyframes, holds its current value)` +
                  (keyedHere ? ' — keyframed at the playhead' : ' — no keyframe at the playhead')
                : `Animate ${label} (keyframes it at the playhead)`
            }
            aria-label={`Toggle ${label} keyframes`}
            aria-pressed={animated}
          >
            {/* D-300 — solid = Phosphor's `fill` weight. */}
            <DiamondIcon size={11} weight={animated ? 'fill' : 'regular'} />
          </button>
          <button
            type="button"
            className={`${SLOT_BUTTON} ${animated ? '' : 'invisible'}`}
            disabled={disabled || !hasNext}
            onClick={() => onNav?.(1)}
            title={`Go to the next ${label} keyframe`}
            aria-label={`Next ${label} keyframe`}
          >
            <CaretRightIcon size={11} />
          </button>
        </>
      )}
      {/* D-233 — only on an ANIMATED property: an ease curve is the shape
          BETWEEN two keyframes, so a static property has nothing to shape. */}
      {onOpenCurve && animated && (
        <button
          type="button"
          disabled={disabled}
          className={`${SLOT_BUTTON} ${curveOpen ? 'text-accent-text' : ''}`}
          onClick={onOpenCurve}
          title={curveOpen ? `Close ${label}'s ease curve` : `Edit ${label}'s ease curves on the timeline`}
          aria-label={`Edit ${label} ease curve`}
          aria-pressed={curveOpen}
        >
          <BezierCurveIcon size={11} />
        </button>
      )}
      <button
        type="button"
        disabled={disabled}
        className={`${SLOT_BUTTON} ${ON_ROW_ACTIVE}`}
        onClick={onReset}
        title={`Reset ${label} to its default`}
        aria-label={`Reset ${label}`}
      >
        <ArrowCounterClockwiseIcon size={11} />
      </button>
    </>
  );
}

/** A property's natural range, for the inline slider (the field keeps its own
 *  `min` / `max`). */
export interface SliderSpan {
  min: number;
  max: number;
}

export function PropertyRow<TParam extends string>({
  label,
  param,
  state,
  step,
  min,
  max,
  unit,
  slider,
  disabled,
  onChange,
  onKeyframeToggle,
  onKeyframeNav,
  onReset,
  onOpenCurve,
  curveOpen = false,
}: {
  label: string;
  param: TParam;
  state: PropertyState;
  step: number;
  min?: number;
  max?: number;
  /** Suffix shown after the value (`°`, `px`). */
  unit?: string;
  /** v0.3.0 — draw an inline slider over this span beside the field. */
  slider?: SliderSpan;
  disabled: boolean;
  onChange: (value: number) => void;
  onKeyframeToggle?: (param: TParam) => void;
  onKeyframeNav?: (param: TParam, dir: -1 | 1) => void;
  onReset: (param: TParam) => void;
  /** D-233 — open (or close) this property's curve in the timeline's curve
   *  editor lane. Optional for the same reason the keyframe trio is: a
   *  property this app deliberately does not animate (D-224's EQ fields) has
   *  no curve, and a permanently-dead button advertises an affordance that
   *  does not exist. Omit it and no curve button is rendered at all. */
  onOpenCurve?: (param: TParam) => void;
  /** Whether the lane is currently showing THIS property — the button's
   *  pressed state, so the row says which curve is open rather than the user
   *  having to look at the timeline to find out. */
  curveOpen?: boolean;
}) {
  const keyframeable = !!onKeyframeToggle && !!onKeyframeNav;
  const slot = (
    <KeyframeSlot
      label={label}
      animated={state.animated}
      keyedHere={state.keyedHere}
      hasPrev={state.prevFrame !== null}
      hasNext={state.nextFrame !== null}
      disabled={disabled}
      onToggle={keyframeable ? () => onKeyframeToggle?.(param) : undefined}
      onNav={keyframeable ? (dir) => onKeyframeNav?.(param, dir) : undefined}
      onReset={() => onReset(param)}
      onOpenCurve={onOpenCurve ? () => onOpenCurve(param) : undefined}
      curveOpen={curveOpen}
    />
  );

  const fieldProps = {
    'aria-label': label,
    value: state.value,
    step,
    min,
    max,
    unit,
    disabled,
    // The field rounds what it SHOWS; the exact stored value is one
    // hover (or one click into the field) away.
    title: `${label}: ${state.value}`,
    onChange,
  };

  return (
    <InspectorRow label={label} disabled={disabled} slot={slot}>
      {slider ? (
        <InspectorSliderField
          {...fieldProps}
          sliderMin={slider.min}
          sliderMax={slider.max}
          onReset={() => onReset(param)}
        />
      ) : (
        <InspectorNumber {...fieldProps} className="min-w-0 flex-1" />
      )}
    </InspectorRow>
  );
}

/** Run several ops as one undo step (the paired row's two-property actions). */
function asOneStep(run: () => void): void {
  beginHistoryGroup();
  try {
    run();
  } finally {
    endHistoryGroup();
  }
}

/** The nearer of two optional frames in one direction. */
function nearer(a: number | null, b: number | null, dir: -1 | 1): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return dir < 0 ? Math.max(a, b) : Math.min(a, b);
}

/** Two properties on one row behind one keyframe slot (v0.3.0, B-359 item 2):
 *  Position as `X [..] Y [..]`, the mockup's and Final Cut's single Position
 *  parameter. Each value keeps its own field, scrub and op; the slot treats
 *  the pair as one property:
 *  - ◇ on a static pair animates both; on a pair where either is animated it
 *    stops every animated one (so the two never end up half-keyed by the
 *    diamond itself);
 *  - ‹ › go to the nearest key of either;
 *  - ↺ resets both;
 *  - the curve button opens the first animated one's curve.
 *  Two-op actions run inside one history group: one undo step. */
export function PairedPropertyRow<TParam extends string>({
  label,
  params,
  prefixes,
  states,
  step,
  min,
  max,
  unit,
  disabled,
  onChange,
  onKeyframeToggle,
  onKeyframeNav,
  onReset,
  onOpenCurve,
  openCurveParam = null,
}: {
  label: string;
  params: readonly [TParam, TParam];
  /** The inline prefixes, `['X', 'Y']`. */
  prefixes: readonly [string, string];
  states: readonly [PropertyState, PropertyState];
  step: number;
  min?: number;
  max?: number;
  unit?: string;
  disabled: boolean;
  onChange: (param: TParam, value: number) => void;
  /** Receives BOTH params at once, so the caller writes them as one keyframe
   *  array (two writes from one render's keyframes would drop the first). */
  onKeyframeToggle?: (params: readonly TParam[]) => void;
  onKeyframeNav?: (param: TParam, dir: -1 | 1) => void;
  /** Both params at once, for the same reason. */
  onReset: (params: readonly TParam[]) => void;
  onOpenCurve?: (param: TParam) => void;
  openCurveParam?: TParam | null;
}) {
  const [a, b] = states;
  const animated = a.animated || b.animated;
  const keyedHere = (a.animated && a.keyedHere) || (b.animated && b.keyedHere);
  const keyframeable = !!onKeyframeToggle && !!onKeyframeNav;
  const firstAnimated = a.animated ? params[0] : b.animated ? params[1] : null;

  // Animated pair → the caller stops each animated one; static pair → it
  // animates both. A static write can ride along, hence the one step.
  const toggle = () => asOneStep(() => onKeyframeToggle?.(params));

  const nav = (dir: -1 | 1) => {
    const target = dir < 0 ? nearer(a.prevFrame, b.prevFrame, -1) : nearer(a.nextFrame, b.nextFrame, 1);
    if (target === null) return;
    // Hand the move to whichever param owns that key.
    const own = (dir < 0 ? a.prevFrame : a.nextFrame) === target ? params[0] : params[1];
    onKeyframeNav?.(own, dir);
  };

  const slot = (
    <KeyframeSlot
      label={label}
      animated={animated}
      keyedHere={keyedHere}
      hasPrev={a.prevFrame !== null || b.prevFrame !== null}
      hasNext={a.nextFrame !== null || b.nextFrame !== null}
      disabled={disabled}
      onToggle={keyframeable ? toggle : undefined}
      onNav={keyframeable ? nav : undefined}
      onReset={() => asOneStep(() => onReset(params))}
      onOpenCurve={onOpenCurve && firstAnimated ? () => onOpenCurve(firstAnimated) : undefined}
      curveOpen={openCurveParam !== null && params.includes(openCurveParam)}
    />
  );

  return (
    <InspectorRow label={label} disabled={disabled} slot={slot}>
      {params.map((p, i) => (
        <InspectorNumber
          key={p}
          aria-label={`${label} ${prefixes[i]}`}
          prefix={prefixes[i]}
          className="min-w-0 flex-1"
          value={states[i].value}
          step={step}
          min={min}
          max={max}
          unit={unit}
          disabled={disabled}
          title={`${label} ${prefixes[i]}: ${states[i].value}`}
          onChange={(v) => onChange(p, v)}
        />
      ))}
    </InspectorRow>
  );
}
