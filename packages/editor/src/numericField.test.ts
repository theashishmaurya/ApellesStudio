/**
 * @apelles/editor — the Inspector numeric field's display precision and its
 * fit budget (B-113, D-253).
 *
 * The rendered half — that a real crop value, in a real Inspector, comes out
 * short enough to be read in full — is `PropertyRow.numericField.dom.test.
 * tsx`. This file pins the arithmetic that one depends on.
 *
 * The precision half of that arithmetic is `@apelles/ui`'s now (D-253 moved it
 * there, next to `ScrubbableNumberInput`, which needs it a layer below this
 * package). It is still exercised HERE, against this panel's own real steps
 * and its own real field width — that pairing is what the assertions are
 * about, and re-testing `displayNumber` in isolation in `@apelles/ui` would
 * only restate the implementation.
 */
import { describe, expect, it } from 'vitest';
import { DISPLAY_DECIMALS_MAX, displayDecimals, displayNumber } from '@apelles/ui';

import {
  NUM_FIELD,
  numericFieldCapacityChars,
  numericFieldFits,
  numericFieldTextWidthPx,
} from './numericField';

describe('display precision, derived from the row’s own step (B-113)', () => {
  it('shows one decimal finer than a hand nudge', () => {
    expect(displayDecimals(0.01)).toBe(3); // crop insets, normalised positions
    expect(displayDecimals(0.05)).toBe(3); // Opacity, Scale, Volume
    expect(displayDecimals(0.1)).toBe(2); // Pan, Q
    expect(displayDecimals(0.5)).toBe(2); // EQ gain
    expect(displayDecimals(1)).toBe(1); // Rotation
    expect(displayDecimals(10)).toBe(1); // EQ frequency
  });

  it('never runs past the cap, whatever the step', () => {
    expect(displayDecimals(0.0001)).toBe(DISPLAY_DECIMALS_MAX);
    expect(displayDecimals(1e-7)).toBe(DISPLAY_DECIMALS_MAX);
    expect(displayDecimals(0)).toBe(DISPLAY_DECIMALS_MAX);
    expect(displayDecimals(Number.NaN)).toBe(DISPLAY_DECIMALS_MAX);
  });
});

describe('what a resting field shows', () => {
  it('rounds the owner’s own crop value to something that fits', () => {
    // 0.052212 is a REAL value out of the owner's project — an on-canvas crop
    // drag stores full float precision. Eight characters is what used to be
    // pushed under the spinner arrows.
    expect(displayNumber(0.052212, 0.01)).toBe(0.052);
    expect(numericFieldFits('0.052212')).toBe(false); // the bug, pinned
    expect(numericFieldFits(String(displayNumber(0.052212, 0.01)))).toBe(true); // the fix
  });

  it('leaves a value that already fits completely alone', () => {
    expect(displayNumber(1, 0.05)).toBe(1);
    expect(displayNumber(0, 0.01)).toBe(0);
    expect(displayNumber(-0.5, 0.1)).toBe(-0.5);
    expect(displayNumber(1000, 10)).toBe(1000);
  });

  it('drops trailing zeros rather than padding them — the field is narrow', () => {
    // `toFixed` would render `0.050`; a number round-trip is what makes it
    // `0.05`, and it is also what keeps the input a controlled NUMBER input.
    expect(displayNumber(0.05, 0.01)).toBe(0.05);
    expect(String(displayNumber(12.5, 1))).toBe('12.5');
  });

  it('passes a non-finite value through untouched for the caller to guard', () => {
    expect(displayNumber(Number.NaN, 0.01)).toBeNaN();
    expect(displayNumber(Infinity, 0.01)).toBe(Infinity);
  });

  it('every value any Inspector row can show at rest fits the field', () => {
    // One case per row that exists today, at its own step, at the widest
    // value it can reach — the whole point of the precision rule.
    const worst: Array<[number, number]> = [
      [-0.523212, 0.01], // Position X/Y, dragged
      [0.052212, 0.01], // crop inset, dragged
      [0.987654, 0.05], // Opacity
      [-179.95, 1], // Rotation
      [20000, 10], // EQ Freq, at its ceiling
      [-24, 0.5], // EQ Gain, at its floor
      [19.95, 0.1], // EQ Q, near its ceiling
      [-0.95, 0.1], // Pan, near hard left
      [2.5, 0.05], // Volume, boosted
    ];
    for (const [value, step] of worst) {
      const shown = String(displayNumber(value, step));
      expect(
        numericFieldFits(shown),
        `${shown} (${shown.length} chars) does not fit ${numericFieldCapacityChars()}`,
      ).toBe(true);
    }
  });
});

describe('the field’s declared geometry', () => {
  it('counts only the field’s own padding out of the usable text width', () => {
    expect(numericFieldTextWidthPx()).toBe(
      NUM_FIELD.widthPx - NUM_FIELD.padLeftPx - NUM_FIELD.padRightPx,
    );
    // Not a tautology: it is what stops a future "make the field narrower"
    // from silently taking the room back out of the digits.
    expect(numericFieldTextWidthPx()).toBeGreaterThan(0);
    expect(numericFieldCapacityChars()).toBeGreaterThanOrEqual(6);
  });

  it('the class string really carries the width and the no-shrink the px say it does', () => {
    // The px constants above are only honest if the utilities beside them are
    // the ones actually rendered. `shrink-0` is the load-bearing one: without
    // it a narrow Inspector squeezes the field and the digits go back under
    // the arrows even though nothing about `widthPx` changed.
    expect(NUM_FIELD.className).toContain('w-20');
    expect(NUM_FIELD.className).toContain('pl-2');
    expect(NUM_FIELD.className).toContain('shrink-0');
    expect(NUM_FIELD.className).toContain('text-right');
    expect(NUM_FIELD.className).toContain('tabular-nums');
    // …and it must NOT set its own right padding: `padRightPx` above is the
    // `Input` base's `px-3`, and a `pr-*` here would silently make that number
    // a lie in whichever direction the caller chose.
    expect(NUM_FIELD.className).not.toMatch(/\b(pr-|px-)/);
  });
});
