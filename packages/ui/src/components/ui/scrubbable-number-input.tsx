/**
 * @chroma/ui — ScrubbableNumberInput: the app's numeric field (D-253,
 * completing B-113).
 *
 * **What it is.** A `type="number"` shadcn `Input` with no spinner arrows and
 * a horizontal drag-to-scrub gesture in their place — Resolve's "virtual
 * slider", Blender's number button, Adobe's scrubbable hot text. Press and
 * drag to change the value; click without moving to get a caret and type an
 * exact one. The gesture itself lives in `useNumberScrub` (shared with
 * `@chroma/motion`, which cannot import this package's barrel); this component
 * is what pairs it with a real controlled input.
 *
 * **What it does NOT do.** It has no label, no keyframe controls, and no
 * knowledge of any panel — `@chroma/editor`'s `PropertyRow` wraps it for the
 * Inspector rows. It is not a slider: there is no track, and the value is
 * unbounded except by whatever `min`/`max` the caller declares.
 *
 * **Two display states, and why (B-113's one part that did work).** At rest
 * the field shows a `step`-derived ROUNDING of the value
 * ([`displayNumber`]) — an on-canvas crop drag stores `0.052212`, and eight
 * characters do not fit an 80px field at any padding. Focused, it shows the
 * exact stored number again, so typing, arrow-key stepping and everything the
 * user can actually edit are byte-for-byte the real value. Nothing is ever
 * rounded on the way OUT: what this component emits is what was typed or what
 * the gesture computed.
 *
 * **The draft string.** While the field has focus, what is displayed is the
 * user's own text, not a re-serialisation of the committed number. Without
 * that, typing `0.052212` is impossible: the value would be re-rendered from
 * the parsed number after every keystroke and a trailing `0` or a just-typed
 * `.` would be erased under the caret. Committing happens per keystroke (as it
 * did before this component existed), the draft is dropped on blur, and an
 * out-of-range typed value is pinned to `min`/`max` at that point — during
 * typing it is not, since clamping mid-keystroke makes a field with a floor
 * impossible to type into.
 */
import * as React from 'react';

import { cn } from '../../lib/utils';
import { useNumberField } from '../../hooks/use-number-scrub';
import { Input } from './input';

export interface ScrubbableNumberInputProps
  extends Omit<
    React.ComponentProps<typeof Input>,
    'type' | 'value' | 'defaultValue' | 'onChange' | 'step' | 'min' | 'max'
  > {
  /** The stored value, or `null` for a field that is legitimately unset (a
   *  Motion manifest property left at the primitive's own default). A `null`
   *  field renders empty and shows its `placeholder`. */
  value: number | null;
  /** Every committed change — per keystroke while typing, per quantised notch
   *  while scrubbing. Absolute, never a delta. */
  onValueChange: (value: number) => void;
  /** What emptying the field means, for a field where "unset" is a real state.
   *  Omit it and clearing the text simply commits nothing and the stored value
   *  comes back on blur, which is what every required field wants. */
  onClear?: () => void;
  /** The field's own notch: the spinner/arrow-key step, the display precision,
   *  and the scrub sensitivity all derive from it. */
  step?: number;
  min?: number;
  max?: number;
}

function ScrubbableNumberInput({
  value,
  onValueChange,
  onClear,
  step = 1,
  min,
  max,
  disabled,
  className,
  onFocus,
  onBlur,
  onPointerDown,
  ...props
}: ScrubbableNumberInputProps) {
  const { scrubbing, focused, inputProps } = useNumberField({
    value,
    step,
    min,
    max,
    disabled,
    onValueChange,
    onClear,
  });

  return (
    <Input
      // The caller's own leftovers first, so the field's own behaviour below
      // cannot be silently replaced by one of them.
      {...props}
      {...inputProps}
      className={cn(
        // The affordance itself: Resolve's own "hover… until you see the
        // virtual slider cursor". Swapped for a caret while the field is
        // focused, because at that point it really is a text box.
        'cursor-ew-resize',
        focused && 'cursor-text',
        scrubbing && 'select-none',
        className,
      )}
      // Composed, not overridden: a caller may legitimately want to know about
      // focus or a press (a panel that opens a section when a field is
      // entered), and it must not cost the field its own handler.
      onPointerDown={(e) => {
        inputProps.onPointerDown(e);
        onPointerDown?.(e);
      }}
      onFocus={(e) => {
        inputProps.onFocus(e);
        onFocus?.(e);
      }}
      onBlur={(e) => {
        inputProps.onBlur(e);
        onBlur?.(e);
      }}
    />
  );
}

export { ScrubbableNumberInput };
