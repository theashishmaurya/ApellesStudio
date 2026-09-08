/**
 * @chroma/editor — the Inspector's numeric field: its declared geometry
 * (B-113, D-253).
 *
 * **What it is.** One place that answers the question every numeric row in the
 * Edit tab's Inspector asks: how wide is the field's usable text area, and
 * therefore how long a rendered value can be before it overflows.
 *
 * **What it does NOT do.** It does not render anything, it knows nothing about
 * `Clip`, and it no longer owns the DISPLAY-precision arithmetic — that moved
 * to `@chroma/ui`'s `useNumberScrub` module (`displayNumber` /
 * `displayDecimals`), because rounding what a number field shows is intrinsic
 * to "a numeric field" rather than to this tab, and `ScrubbableNumberInput`
 * needs it in a package that sits BELOW this one. Import them from
 * `@chroma/ui`.
 *
 * **Why it exists (B-113).** The crop rows showed values like `0.0` with the
 * spinner arrows drawn over the missing digits. Two independent causes:
 *
 *  1. **The native spinner sat on the digits.** B-113 first tried to reserve a
 *     padding strip for it, which could not work — WebKit lays
 *     `::-webkit-inner-spin-button` out inside the padding box, so padding
 *     moves the text and the arrows together. D-253 removed the spinner
 *     instead (`@chroma/ui`'s `Input`, for every `type="number"` in the app)
 *     and put drag-to-scrub in its place, so the field's whole width minus its
 *     own padding is now really the value's.
 *  2. **The raw stored float was rendered at full precision.** An on-canvas
 *     crop drag stores e.g. `0.052212`; eight characters do not fit a field
 *     this narrow at any padding, so the text overflowed and was scrolled out
 *     of view. `@chroma/ui`'s `displayNumber` rounds what is SHOWN to a
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

/** The Inspector's numeric field, as one class string plus the pixel values
 *  those exact utilities resolve to.
 *
 *  `shrink-0` is load-bearing, not tidiness: the field sits in a `flex-1`
 *  label beside a truncating text span, so without it a narrow Inspector
 *  shrinks the field below `widthPx` and the digits overflow again — the very
 *  defect this module exists to close. `tabular-nums` likewise: it makes every
 *  digit the same advance, which is what lets [`numericFieldFits`] reason
 *  about a string's width at all. */
export const NUM_FIELD = {
  /** `w-20` = 80px, `pl-2` = 8px. The right padding is NOT set here: it is the
   *  shadcn `Input` base's own `px-3`, and restating it would let a caller
   *  silently override half of a symmetric pair. */
  className: 'h-7 w-20 shrink-0 pl-2 text-right tabular-nums',
  /** `w-20` */
  widthPx: 80,
  /** `pl-2` */
  padLeftPx: 8,
  /** `px-3` from `@chroma/ui`'s `Input` base, unopposed on the right now that
   *  no spinner is painted there (D-253). */
  padRightPx: 12,
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
 *  padding on both sides. */
export function numericFieldTextWidthPx(): number {
  return NUM_FIELD.widthPx - NUM_FIELD.padLeftPx - NUM_FIELD.padRightPx;
}

/** Does this rendered value fit that width, i.e. is every digit visible? The
 *  one assertion B-113 is actually about. */
export function numericFieldFits(text: string): boolean {
  return text.length * NUM_FIELD.charPx <= numericFieldTextWidthPx();
}

/** How many characters do fit, for a test's own error message. */
export function numericFieldCapacityChars(): number {
  return Math.floor(numericFieldTextWidthPx() / NUM_FIELD.charPx);
}

// `DISPLAY_DECIMALS_MAX` / `displayDecimals` / `displayNumber` used to live
// here. They are `@chroma/ui`'s now (`hooks/use-number-scrub.ts`) — see this
// module's own doc for why — and are re-exported by nothing: import them from
// `@chroma/ui` directly.
