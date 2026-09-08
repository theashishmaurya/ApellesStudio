/**
 * @chroma/editor — one keyframeable Inspector row: label, numeric field,
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
 * `@chroma/inspector`'s own README warns against. What actually IS shared,
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
 * Pure presentation, like the panel it came from: no store access, no
 * `Clip` knowledge, nothing beyond the props below.
 */
import { ChevronLeft, ChevronRight, Diamond, RotateCcw, Spline } from 'lucide-react';
import { Button, Input } from '@chroma/ui';

const row = 'flex items-center justify-between gap-2';
/** D-208 — a property row's field shares its line with four icon buttons,
 *  so it runs one step narrower than a plain numeric row's own input. */
const propInput = 'h-7 w-16 text-right';

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

/** One Transform/Crop-shaped row: label, value field, that property's own
 *  keyframe nav + stopwatch diamond, its own reset (D-208), and — when it is
 *  animated — the button that opens its ease curve on the timeline (D-233).
 *
 *  `TParam` is whatever the caller's own property-name type is
 *  (`ClipTransformParam` for the Transform/Crop/Audio rows, an EQ band's own
 *  field name for D-224's) — this component never inspects the value, only
 *  passes it back to the callbacks, so it stays correct for a param type it
 *  has never seen.
 *
 *  **The keyframe controls are optional** (D-224): pass neither
 *  `onKeyframeToggle` nor `onKeyframeNav` and the `<`/diamond/`>` trio is not
 *  rendered at all, leaving a plain label + field + reset row. That is for a
 *  property that genuinely cannot be animated — three permanently-disabled
 *  buttons would advertise an affordance that does not exist. `onReset` stays
 *  required either way: every property here has a rest value. */
export function PropertyRow<TParam extends string>({
  label,
  param,
  state,
  step,
  min,
  max,
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
  // Both together or neither — a row with nav arrows but no diamond (or the
  // reverse) is not a state any caller wants, and this keeps the three buttons
  // one render decision rather than three independent ones.
  const keyframeable = !!onKeyframeToggle && !!onKeyframeNav;
  return (
    <div className={row}>
      {/* The label still really labels the input (clicking it focuses the
          field) — which is why the buttons live OUTSIDE this element: a
          <label> wrapping them would make every icon click also hit the
          input. */}
      <label className="flex min-w-0 flex-1 items-center justify-between gap-2">
        <span className="text-text-secondary truncate">{label}</span>
        <Input
          type="number"
          step={step}
          min={min}
          max={max}
          disabled={disabled}
          className={propInput}
          value={state.value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </label>
      <div className="flex shrink-0 items-center">
        {keyframeable && (
          <>
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={disabled || state.prevFrame === null}
              onClick={() => onKeyframeNav?.(param, -1)}
              title={`Go to the previous ${label} keyframe`}
              aria-label={`Previous ${label} keyframe`}
            >
              <ChevronLeft size={12} />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={disabled}
              // Animated AND a key right here reads at full strength; animated
              // but between keys is dimmed. That is the whole reason `<`/`>`
              // mean anything — without it there is no way to tell, from the
              // row, whether the playhead is sitting on one of this property's
              // keys or between two of them.
              className={
                state.animated ? (state.keyedHere ? 'text-accent' : 'text-accent/50') : 'text-text-secondary'
              }
              onClick={() => onKeyframeToggle?.(param)}
              title={
                state.animated
                  ? `Stop animating ${label} (removes its keyframes, holds its current value)` +
                    (state.keyedHere ? ' — keyframed at the playhead' : ' — no keyframe at the playhead')
                  : `Animate ${label} (keyframes it at the playhead)`
              }
              aria-label={`Toggle ${label} keyframes`}
              aria-pressed={state.animated}
            >
              {/* Filled = this property is animated, hollow = static — the same
                  Diamond-plus-fill convention `RelightPanel.tsx` and this
                  panel's own Keyframes section already use. */}
              <Diamond size={11} fill={state.animated ? 'currentColor' : 'none'} />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={disabled || state.nextFrame === null}
              onClick={() => onKeyframeNav?.(param, 1)}
              title={`Go to the next ${label} keyframe`}
              aria-label={`Next ${label} keyframe`}
            >
              <ChevronRight size={12} />
            </Button>
          </>
        )}
        {/* D-233 — only on an ANIMATED property. An ease curve is the shape
            BETWEEN two keyframes, so a static property has nothing to shape;
            showing the button anyway would open an empty lane. The row's own
            diamond is how you get from static to animated, and it is
            immediately to the left. */}
        {onOpenCurve && state.animated && (
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={disabled}
            className={curveOpen ? 'text-accent' : undefined}
            onClick={() => onOpenCurve(param)}
            title={
              curveOpen
                ? `Close ${label}'s ease curve`
                : `Edit ${label}'s ease curves on the timeline`
            }
            aria-label={`Edit ${label} ease curve`}
            aria-pressed={curveOpen}
          >
            <Spline size={11} />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          disabled={disabled}
          onClick={() => onReset(param)}
          title={`Reset ${label} to its default`}
          aria-label={`Reset ${label}`}
        >
          <RotateCcw size={11} />
        </Button>
      </div>
    </div>
  );
}
