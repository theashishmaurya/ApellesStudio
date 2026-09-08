/**
 * @chroma/editor — the Inspector's numeric field: its declared geometry and
 * its display formatting (B-113).
 *
 * **What it is.** One place that answers two questions every numeric row in
 * the Edit tab's Inspector asks: how wide is the field's usable text area
 * (i.e. the part the native spinner does NOT sit on top of), and how many
 * decimals of a stored value can honestly be shown in it.
 *
 * **What it does NOT do.** It does not render anything, it knows nothing
 * about `Clip`, and it never changes a stored value — [`displayNumber`] is a
 * DISPLAY rounding only. The value written back to the timeline is always the
 * one the user typed or stepped, at full precision.
 *
 * **Why it exists (B-113).** The crop rows showed values like `0.0` with the
 * spinner arrows drawn over the missing digits. Two independent causes, both
 * fixed here:
 *
 *  1. **No space was reserved for the native spinner.** In WKWebView (which
 *     is what Tauri renders in on macOS) `::-webkit-inner-spin-button` is
 *     painted inside the field's right edge without taking any layout space,
 *     so a `text-right` value runs underneath it. The reserve is now applied
 *     by `@chroma/ui`'s `Input` itself for every `type="number"` field
 *     ([`NUMBER_INPUT_SPINNER_RESERVE`]) rather than by each caller — the
 *     defect belongs to "a number input", not to this panel.
 *  2. **The raw stored float was rendered at full precision.** An
 *     on-canvas crop drag stores e.g. `0.052212`; eight characters do not fit
 *     a field this narrow at any padding, so the text overflowed and was
 *     scrolled out of view. [`displayNumber`] rounds what is SHOWN to a
 *     precision derived from the row's own `step` — one decimal finer than a
 *     hand nudge — while the field shows the exact value again the moment it
 *     is focused, so typing and stepping are byte-for-byte what they were.
 *
 * **The px constants are the Tailwind classes' own values**, restated here so
 * a test can check that what is rendered actually fits rather than only that
 * it renders. They are paired with the class string in [`NUM_FIELD`] so the
 * two cannot drift apart silently: change the class, change the number beside
 * it. jsdom has no layout engine, so this declared geometry is what a DOM test
 * can honestly assert — see `PropertyRow.numericField.dom.test.tsx`.
 */
import { NUMBER_INPUT_SPINNER_RESERVE } from '@chroma/ui';

/** The Inspector's numeric field, as one class string plus the pixel values
 *  those exact utilities resolve to.
 *
 *  `shrink-0` is load-bearing, not tidiness: the field sits in a `flex-1`
 *  label beside a truncating text span, so without it a narrow Inspector
 *  shrinks the field below `widthPx` and puts the digits back under the
 *  spinner — the very defect this module exists to close. `tabular-nums`
 *  likewise: it makes every digit the same advance, which is what lets
 *  [`numericFieldFits`] reason about a string's width at all. */
export const NUM_FIELD = {
  /** `w-20` = 80px, `pl-2` = 8px. The right padding is NOT set here: it is
   *  `@chroma/ui`'s own spinner reserve for `type="number"`, and restating it
   *  would let a caller silently override it. */
  className: 'h-7 w-20 shrink-0 pl-2 text-right tabular-nums',
  /** `w-20` */
  widthPx: 80,
  /** `pl-2` */
  padLeftPx: 8,
  /** Applied by `@chroma/ui`'s `Input` for `type="number"`. */
  spinnerReservePx: NUMBER_INPUT_SPINNER_RESERVE.px,
  /** `text-sm` (the `Input` base class), in px. */
  fontPx: 14,
  /** A conservative UPPER bound on one character's advance at `fontPx` with
   *  `tabular-nums`: digits in the app's UI sans run ≈0.6em, and `-` / `.`
   *  are narrower still, so treating every character as a widest-digit is a
   *  bound in the safe direction. Deliberately not measured at runtime —
   *  jsdom cannot measure text, and a bound that errs towards "too wide" can
   *  only make [`numericFieldFits`] stricter, never wronger. */
  charPx: 8.4,
} as const;

/** The width a value's text really has to itself — the field minus its own
 *  left padding and minus the strip the native spinner is painted over. */
export function numericFieldTextWidthPx(): number {
  return NUM_FIELD.widthPx - NUM_FIELD.padLeftPx - NUM_FIELD.spinnerReservePx;
}

/** Does this rendered value fit that width, i.e. is every digit visible and
 *  clear of the spinner? The one assertion B-113 is actually about. */
export function numericFieldFits(text: string): boolean {
  return text.length * NUM_FIELD.charPx <= numericFieldTextWidthPx();
}

/** How many characters do fit, for a test's own error message. */
export function numericFieldCapacityChars(): number {
  return Math.floor(numericFieldTextWidthPx() / NUM_FIELD.charPx);
}

/** The most decimals any Inspector field ever displays. Three is what the
 *  finest step here (`0.01`, the crop insets and normalised positions) needs
 *  to show one place finer than a hand nudge; beyond that the digits are
 *  below what either the preview or a human can act on, and they are exactly
 *  the ones that used to push the value under the spinner. */
export const DISPLAY_DECIMALS_MAX = 3;

/** The display precision for a row whose spinner steps by `step`: one decimal
 *  finer than the step itself, capped at [`DISPLAY_DECIMALS_MAX`].
 *
 *  Deriving it from `step` rather than hardcoding per row is what keeps this
 *  honest as fields are added: a row that steps by whole numbers (Rotation,
 *  Freq) shows one decimal, a row that steps by hundredths (crop, position)
 *  shows three. */
export function displayDecimals(step: number): number {
  const magnitude = Math.abs(step);
  if (!Number.isFinite(magnitude) || magnitude <= 0) return DISPLAY_DECIMALS_MAX;
  const text = String(magnitude);
  // A step written in exponential notation is finer than anything this panel
  // uses; fall back to the cap rather than mis-parsing `1e-7`.
  if (text.includes('e') || text.includes('E')) return DISPLAY_DECIMALS_MAX;
  const dot = text.indexOf('.');
  const stepDecimals = dot < 0 ? 0 : text.length - dot - 1;
  return Math.min(stepDecimals + 1, DISPLAY_DECIMALS_MAX);
}

/** What a row SHOWS for a stored value — never what it stores.
 *
 *  Returns a `number` (not a string) so a controlled `type="number"` input
 *  keeps behaving exactly as it did: React's own number-input diffing is what
 *  makes typing a decimal work, and handing it a pre-formatted string would
 *  change that. Trailing zeros are therefore dropped by construction
 *  (`Number('0.050')` is `0.05`), which is what we want in a field this
 *  narrow. Non-finite values pass through untouched — the caller's own
 *  `Number.isFinite` guards decide what to do with them. */
export function displayNumber(value: number, step: number): number {
  if (!Number.isFinite(value)) return value;
  return Number(value.toFixed(displayDecimals(step)));
}
