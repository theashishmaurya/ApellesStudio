/**
 * @apelles/ui — drag-to-scrub for a numeric field: the arithmetic, and the
 * headless gesture (D-253, completing B-113).
 *
 * **What it is.** The "virtual slider" every established grading/NLE tool puts
 * on its Inspector number fields — press on the number, drag horizontally, the
 * value follows; click without moving and you get a normal text caret to type
 * into. Blackmagic's own Resolve manual uses that exact term for it ("When
 * number fields appear in the Inspector, they can be used as a virtual slider
 * by hovering the pointer over them until you see the virtual slider cursor,
 * and then clicking and dragging to the right to raise the value, or to the
 * left to lower the value… to enter a specific value, double-click in the
 * number field, type the value, and press Return"), and Blender's Number
 * Buttons ("hold down LMB and drag the mouse to the left or right"; "Press LMB
 * or Return to edit the value as a text field") work the same way.
 *
 * **What it does NOT do.** It renders nothing. [`useNumberScrub`] is the
 * gesture alone (an `onPointerDown` and a `scrubbing` flag);
 * [`useNumberField`] is the whole field's behaviour — that gesture plus the
 * rounded-at-rest / exact-when-focused display split and the typing draft —
 * handed back as props to spread onto whatever `<input>` the caller owns.
 *
 * The two consumers are [`ScrubbableNumberInput`] (this package, on the shadcn
 * `Input`) and `@apelles/motion`'s `InspectorPanel`, which cannot import this
 * package's barrel at all (`@react-three/fiber`'s global JSX augmentation vs.
 * `Text.tsx`'s polymorphic `as` prop — see `packages/motion/src/Button.tsx`)
 * and therefore reaches this file through the `@apelles/ui/number-scrub`
 * subpath, which pulls in nothing but React. Sharing the behaviour rather than
 * writing it twice is the whole reason it is split out from the component.
 *
 * **Why this exists at all (B-113, finished here).** B-113 reported the Crop
 * fields' spinner arrows drawn on top of their own digits and fixed it by
 * reserving a `pr-5` strip on every `type="number"`. That could not have
 * worked and did not: WebKit lays `::-webkit-inner-spin-button` out INSIDE the
 * field's padding box, so more `padding-right` moves the text and the spinner
 * left by the same amount and the overlap survives exactly. The real fix is to
 * remove the spinner (`input.tsx`'s [`NUMBER_INPUT_SPINNER_SUPPRESSION`]) —
 * which then leaves the field with no pointer affordance for changing the
 * value at all, and this is what replaces it. Arrow-key stepping is untouched:
 * suppressing the spin BUTTON does not disable a number input's keyboard
 * stepping.
 */
import * as React from 'react';

// ---------------------------------------------------------------------------
// Sensitivity
// ---------------------------------------------------------------------------

/** The scrub gesture's declared feel. Every number here is named rather than
 *  inlined, and every one of them is a decision, not a tuning accident. */
export const NUMBER_SCRUB = {
  /** Horizontal travel that equals ONE of the field's own declared `step`.
   *
   *  Deriving the sensitivity from `step` rather than from a per-field pixel
   *  rate is what makes one constant correct for every field in the app: a
   *  Rotation row (`step={1}`) moves a degree per 8px, a crop inset
   *  (`step={0.01}`) moves a hundredth, and neither needed its own tuning.
   *  8px is roughly a comfortable pixel-per-notch on a trackpad — a full
   *  120px flick is 15 notches — and it is deliberately coarser than 1px/step
   *  so a field with a large step (EQ frequency, `step={10}`) is not
   *  unusable. */
  PX_PER_STEP: 8,
  /** How far the pointer must travel before the press counts as a scrub
   *  rather than a click.
   *
   *  Deliberately the SAME number, measured the same way, as the timeline's
   *  own `PointerSensor` `activationConstraint: { distance: 4 }` and
   *  `marquee.ts`'s `MARQUEE_MIN_DRAG_PX` — this repo already settled once
   *  what counts as "a drag rather than a click," and a second, different
   *  answer on another surface is exactly the near-miss that file's own
   *  history is made of. (Restated here rather than imported because
   *  `@apelles/editor` sits ABOVE this package; the dependency may not run the
   *  other way.) */
  MIN_DRAG_PX: 4,
  /** Shift — ten steps per notch.
   *
   *  Adobe's, not Blender's. After Effects and Premiere scrub hot text with
   *  Shift = ×10 and Command (macOS) = ÷10; Blender inverts it, using Shift
   *  for the fine pass. Resolve/Premiere/AE are this repo's stated reference
   *  tools (see CLAUDE.md's "research the real pattern first"), so the Adobe
   *  reading wins. */
  COARSE_FACTOR: 10,
  /** Meta (Command) — a tenth of a step per notch.
   *
   *  Adobe spells the fine modifier Command on macOS and Control on Windows.
   *  macOS is this app's only v1 platform and Control-drag there IS the
   *  secondary-click gesture, so Control would fight the context menu; Meta
   *  is both the Adobe-correct and the only non-conflicting choice. */
  FINE_FACTOR: 0.1,
} as const;

/** The most decimals a scrubbed value is ever rounded to. A guard on
 *  `toFixed`, not a design limit — no field in this app declares a step finer
 *  than `0.01`. */
export const SCRUB_DECIMALS_MAX = 10;

/** The most decimals any field DISPLAYS at rest (B-113). Three is what the
 *  finest step here (`0.01`, the crop insets and normalised positions) needs
 *  to show one place finer than a hand nudge; beyond that the digits are below
 *  what either the preview or a human can act on, and they are exactly the
 *  ones that used to overflow a narrow field. */
export const DISPLAY_DECIMALS_MAX = 3;

/** How many decimals a step is WRITTEN with — `0.01` → 2, `0.5` → 1, `10` → 0.
 *
 *  Read off the declared step's own decimal text, never off `step * factor`:
 *  rounding a scrub to `stepDecimals(0.05 * 0.1)` would be rounding to the
 *  decimals of `0.005000000000000001`, and float dust in the ROUNDING
 *  precision is how a value ends up displayed as `0.15000000000000002`. */
export function stepDecimals(step: number): number {
  const magnitude = Math.abs(step);
  if (!Number.isFinite(magnitude) || magnitude <= 0) return 0;
  const text = String(magnitude);
  // `1e-7`: the decimals are the mantissa's own plus the exponent.
  const negativeExponent = /e-(\d+)$/i.exec(text);
  if (negativeExponent) {
    const dot = text.indexOf('.');
    const mantissa = dot < 0 ? 0 : text.indexOf('e') - dot - 1;
    return Math.min(mantissa + Number(negativeExponent[1]), SCRUB_DECIMALS_MAX);
  }
  // `1e+21` and friends are integral; anything else is plain decimal text.
  if (text.includes('e') || text.includes('E')) return 0;
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : Math.min(text.length - dot - 1, SCRUB_DECIMALS_MAX);
}

/** The display precision for a field whose spinner steps by `step`: one
 *  decimal finer than the step itself, capped at [`DISPLAY_DECIMALS_MAX`].
 *
 *  Deriving it from `step` rather than hardcoding per row is what keeps this
 *  honest as fields are added: a row that steps by whole numbers (Rotation,
 *  Freq) shows one decimal, a row that steps by hundredths (crop, position)
 *  shows three. */
export function displayDecimals(step: number): number {
  const magnitude = Math.abs(step);
  if (!Number.isFinite(magnitude) || magnitude <= 0) return DISPLAY_DECIMALS_MAX;
  const text = String(magnitude);
  // A step written in exponential notation is finer than anything this app
  // uses; fall back to the cap rather than showing ten decimals.
  if (text.includes('e') || text.includes('E')) return DISPLAY_DECIMALS_MAX;
  return Math.min(stepDecimals(step) + 1, DISPLAY_DECIMALS_MAX);
}

/** What a resting field SHOWS for a stored value — never what it stores.
 *
 *  Returns a `number`, so trailing zeros are dropped by construction
 *  (`Number('0.050')` is `0.05`), which is what a narrow field wants.
 *  Non-finite values pass through untouched — the caller's own
 *  `Number.isFinite` guards decide what to do with them. */
export function displayNumber(value: number, step: number): number {
  if (!Number.isFinite(value)) return value;
  return Number(value.toFixed(displayDecimals(step)));
}

/** `value` pinned into whichever of `min`/`max` are declared. */
export function clampNumber(value: number, min?: number, max?: number): number {
  let out = value;
  if (min != null && out < min) out = min;
  if (max != null && out > max) out = max;
  return out;
}

/** Which sensitivity a modifier state asks for. Shift wins over Meta when
 *  both are down — a deliberate tiebreak, not an accident: the coarse pass is
 *  the one a user reaches for mid-drag, so a stray Command should not silently
 *  turn it into the fine one. */
export function scrubFactor(modifiers: { shiftKey: boolean; metaKey: boolean }): number {
  if (modifiers.shiftKey) return NUMBER_SCRUB.COARSE_FACTOR;
  if (modifiers.metaKey) return NUMBER_SCRUB.FINE_FACTOR;
  return 1;
}

/** The value a scrub of `dxPx` from `startValue` lands on — the whole of the
 *  gesture's arithmetic, DOM-free so it is directly testable.
 *
 *  Quantised to whole steps (`Math.round(dx / PX_PER_STEP)`) rather than left
 *  continuous: a field whose declared step is `1` should never come back
 *  `37.4`, and snapping to the notch is also what makes a drag land on the
 *  same number twice. The result is then rounded to the DECLARED step's own
 *  decimals (one more in the fine pass, which is what makes ÷10 reach a place
 *  the step alone cannot), which is what keeps `0.05 * 3 * 0.1` from arriving
 *  as `0.015000000000000001`. */
export function scrubbedValue(startValue: number, dxPx: number, step: number, factor: number): number {
  const steps = Math.round(dxPx / NUMBER_SCRUB.PX_PER_STEP);
  const extra = factor < 1 ? 1 : 0;
  const decimals = Math.min(stepDecimals(step) + extra, SCRUB_DECIMALS_MAX);
  return Number((startValue + steps * step * factor).toFixed(decimals));
}

// ---------------------------------------------------------------------------
// The gesture
// ---------------------------------------------------------------------------

export interface NumberScrubOptions {
  /** The field's current value, or `null` for an unset optional field — a
   *  scrub starting from unset starts from `0`, since a drag has to move
   *  something. */
  value: number | null;
  step: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  /** Called on every quantised change during the drag. Absolute, never a
   *  delta — every value in the gesture is computed from the press-time
   *  value, so a dropped move event cannot accumulate error. */
  onValueChange: (value: number) => void;
}

export interface NumberScrub {
  /** True from the moment the press passes [`NUMBER_SCRUB.MIN_DRAG_PX`] until
   *  the pointer is released — i.e. "this press turned out to be a drag." */
  scrubbing: boolean;
  /** Spread onto the number `<input>`. Deliberately does NOT
   *  `preventDefault()`: a press that never moves must still focus the field
   *  and place a caret, which is how the exact-value-typing half of Resolve's
   *  own pattern stays available. */
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
}

interface Gesture {
  pointerId: number;
  startX: number;
  startValue: number;
  element: HTMLElement;
  /** Has the press passed the drag threshold yet? */
  active: boolean;
}

export function useNumberScrub({
  value,
  step,
  min,
  max,
  disabled,
  onValueChange,
}: NumberScrubOptions): NumberScrub {
  const [scrubbing, setScrubbing] = React.useState(false);

  // The move/up listeners are registered imperatively inside `onPointerDown`
  // (there is no re-render between the press and the first move to hang an
  // effect off), so they would otherwise close over the render that started
  // the gesture. This ref is what keeps them reading the current props.
  const latest = React.useRef({ value, step, min, max, disabled, onValueChange });
  latest.current = { value, step, min, max, disabled, onValueChange };

  const gesture = React.useRef<Gesture | null>(null);
  const stop = React.useRef<() => void>(() => {});

  // A gesture in flight when the field unmounts (an Inspector that re-renders
  // for a new selection mid-drag) must not leave window listeners behind.
  React.useEffect(() => () => stop.current(), []);

  const onPointerDown = React.useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (latest.current.disabled) return;
    // Left button only, primary pointer only: a right-press opens the context
    // menu and a secondary touch point is not a scrub.
    if (event.button !== 0 || !event.isPrimary) return;
    if (gesture.current) return;

    const element = event.currentTarget;
    const current: Gesture = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startValue: latest.current.value ?? 0,
      element,
      active: false,
    };
    gesture.current = current;

    // Pointer capture keeps a real browser delivering the rest of the gesture
    // to this element once the pointer leaves it — which happens almost at
    // once, since the field is 80px wide and a scrub routinely runs further
    // than that. Guarded rather than assumed: jsdom implements no pointer
    // capture API at all (`pointerHarness.ts`'s own
    // `installPointerCaptureStub` documents the same gap), and the gesture is
    // driven off `window` listeners below, so capture is a nicety here, not
    // the mechanism.
    if (typeof element.setPointerCapture === 'function') {
      try {
        element.setPointerCapture(event.pointerId);
      } catch {
        // A pointer that is already gone; the window listeners still finish.
      }
    }

    const move = (e: PointerEvent) => {
      const g = gesture.current;
      if (!g || e.pointerId !== g.pointerId) return;
      const dx = e.clientX - g.startX;
      if (!g.active) {
        if (Math.abs(dx) < NUMBER_SCRUB.MIN_DRAG_PX) return;
        g.active = true;
        setScrubbing(true);
        // A scrub is not a text edit. Leaving the field drops the caret and
        // any selection, so what is on screen for the rest of the drag is the
        // gesture's value rather than a half-typed draft.
        g.element.blur();
        // B-136 (see `ScrubbableNumberInput`'s own module doc for the full,
        // multi-round story): the ACTUAL visible feedback during a scrub is
        // `ScrubbableNumberInput`'s `ScrubCursorGhost`, a portaled DOM
        // element that isn't a cursor property at all and so cannot be
        // frozen or overridden by WebKit's mousedown cursor freeze the way
        // every cursor-API attempt was. `onPointerDown`'s own `cursor: none`
        // write (above, at press time) is a best-effort attempt to also hide
        // the real OS arrow underneath the ghost — set there rather than
        // here because the freeze locks in whatever the cursor was AT
        // mousedown, and by the time this code runs (only once a real drag
        // is already confirmed) that moment has already passed. This capture
        // release remains for its own, independent reason: capture was only
        // ever "a nicety" here (see the comment where it's taken, above),
        // since the window listeners are the real delivery mechanism and
        // releasing it early costs nothing.
        if (typeof g.element.releasePointerCapture === 'function') {
          try {
            g.element.releasePointerCapture(e.pointerId);
          } catch {
            // Already released, or never captured.
          }
        }
      }
      // Stops the travel from selecting the field's own digits as it goes.
      e.preventDefault();
      const opts = latest.current;
      opts.onValueChange(
        clampNumber(scrubbedValue(g.startValue, dx, opts.step, scrubFactor(e)), opts.min, opts.max),
      );
    };

    const end = (e: PointerEvent) => {
      const g = gesture.current;
      if (g && e.pointerId !== g.pointerId) return;
      stop.current();
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);

    stop.current = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      if (typeof element.releasePointerCapture === 'function') {
        try {
          element.releasePointerCapture(current.pointerId);
        } catch {
          // Already released, or never captured.
        }
      }
      gesture.current = null;
      stop.current = () => {};
      setScrubbing(false);
    };
  }, []);

  return { scrubbing, onPointerDown };
}

// ---------------------------------------------------------------------------
// The whole field
// ---------------------------------------------------------------------------

export interface NumberFieldOptions extends NumberScrubOptions {
  /** What emptying the field means, for a field where "unset" is a real state
   *  (a Motion manifest property left at the primitive's own default). Omit it
   *  and clearing the text commits nothing, which is what every required field
   *  wants. */
  onClear?: () => void;
  /** Does a RESTING field show a `step`-derived rounding of the value
   *  ([`displayNumber`], B-113's own fix for a narrow field), or the stored
   *  number verbatim? Defaults to rounding, which is what the Edit tab's
   *  80px Inspector rows need.
   *
   *  `false` is for a field whose `step` says nothing useful about its
   *  precision — Motion's manifest fields declare no per-property step, so
   *  rounding them to the default step's one decimal would turn a `0.25`
   *  duration into `0.3` on screen. Those fields are full width and have room
   *  for the digits, so there is nothing to round for. */
  roundDisplay?: boolean;
}

/** Everything a numeric `<input>` needs, ready to spread. */
export interface NumberFieldInputProps {
  type: 'number';
  value: string;
  step: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  /** Present (empty string) only while a drag is in progress — a hook for a
   *  test or a style, in the `data-*` idiom this repo already uses for
   *  `[data-chroma-clip-drag]`. */
  'data-scrubbing'?: '';
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onFocus: (event: React.FocusEvent<HTMLInputElement>) => void;
  onBlur: (event: React.FocusEvent<HTMLInputElement>) => void;
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
}

export interface NumberField {
  scrubbing: boolean;
  focused: boolean;
  inputProps: NumberFieldInputProps;
}

/** The complete behaviour of one of this app's numeric fields: the scrub
 *  gesture above, plus the two display states and the typing draft that make a
 *  rounded-at-rest field still editable at full precision.
 *
 *  Split out from [`ScrubbableNumberInput`] rather than living inside it
 *  because `@apelles/motion` needs exactly this behaviour on a raw `<input>` of
 *  its own (it cannot import this package's barrel — see the module doc), and
 *  a second hand-written copy of the draft rules is precisely the duplication
 *  this repo's "shared logic → extract, don't copy" rule exists to prevent.
 *
 *  **The draft.** While the field has focus, what is displayed is the user's
 *  own text, not a re-serialisation of the committed number. Without that,
 *  typing `0.052212` is impossible: the value would be re-rendered from the
 *  parsed number after every keystroke and a trailing `0` or a just-typed `.`
 *  would vanish under the caret. The draft is honoured ONLY while focused — an
 *  edit in progress is by definition a focused one, and a draft that outlived
 *  its focus would pin the field to a stale string and stop it tracking the
 *  value it is bound to (an Inspector row would keep showing what was typed
 *  into it while the playhead moved to a frame where the property interpolates
 *  to something else).
 *
 *  **Range.** `min`/`max` pin a SCRUBBED value as it is produced, and a TYPED
 *  one on blur — never mid-keystroke, since clamping each keystroke makes a
 *  field with a floor impossible to type into (`5` on the way to `50` in a
 *  field whose minimum is `10`). */
export function useNumberField({
  value,
  step,
  min,
  max,
  disabled,
  onValueChange,
  onClear,
  roundDisplay = true,
}: NumberFieldOptions): NumberField {
  const [draft, setDraft] = React.useState<string | null>(null);
  const [focused, setFocused] = React.useState(false);
  // What this field itself last pushed via `onValueChange` — the only way to
  // tell "the incoming `value` prop is the round-trip of my own edit" (leave
  // the draft alone, so a trailing "." or "0" the user just typed survives)
  // apart from "something ELSE changed it" (undo/redo, a different clip's
  // value arriving on the same prop, a keyframe/playhead move) — which must
  // win immediately, not just on blur.
  const lastPushedRef = React.useRef<number | null>(null);

  const { scrubbing, onPointerDown } = useNumberScrub({ value, step, min, max, disabled, onValueChange });

  // Adjusting state during render (React's own documented pattern for
  // resetting derived state on an external change) rather than an effect: an
  // effect would commit one stale frame first, letting Cmd+Z's real value
  // flash the old draft before correcting itself.
  if (draft !== null && value !== lastPushedRef.current) {
    setDraft(null);
  }

  const editing = focused && draft !== null;
  const shown = editing
    ? (draft as string)
    : value == null
      ? ''
      : String(focused || !roundDisplay ? value : displayNumber(value, step));

  return {
    scrubbing,
    focused,
    inputProps: {
      type: 'number',
      value: shown,
      step,
      min,
      max,
      disabled,
      'data-scrubbing': scrubbing ? '' : undefined,
      onPointerDown,
      onFocus: () => setFocused(true),
      onBlur: () => {
        setFocused(false);
        const text = draft;
        setDraft(null);
        if (text != null && text.trim() !== '') {
          const typed = Number(text);
          if (Number.isFinite(typed)) {
            const pinned = clampNumber(typed, min, max);
            if (pinned !== typed) onValueChange(pinned);
          }
        }
      },
      onChange: (event) => {
        const text = event.currentTarget.value;
        setDraft(text);
        // A number input reports `''` both for a cleared field and for a
        // half-typed one (`-`, `1.`, `1e`), which is exactly why an empty
        // field commits nothing unless the caller has said what empty MEANS.
        if (text.trim() === '') {
          onClear?.();
          return;
        }
        const typed = Number(text);
        if (Number.isFinite(typed)) {
          lastPushedRef.current = typed;
          onValueChange(typed);
        }
      },
    },
  };
}
