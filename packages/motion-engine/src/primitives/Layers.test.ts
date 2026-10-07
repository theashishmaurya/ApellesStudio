/**
 * B-240 — a `layers` callout picked a side and then drew `nowrap`; when it
 * did not fit on the right it flipped to `"left"` and was laid out at a
 * NEGATIVE x, rendering entirely outside the canvas with no error and no
 * clipping artefact. Fixed by making the placement a real measurement —
 * `layoutCallout` in `Layers.tsx` — that falls back to centring the text
 * under the stack when neither side has room, anchors the box inside the
 * canvas, and caps its width to the space actually there so it wraps.
 *
 * Colocated with `Layers.tsx` in the plain `node` environment, the same
 * shape `Graph.test.ts` uses for `graphLabelFontSize` — this is a pure
 * function and needs no DOM (see `vitest.config.ts`'s own comment).
 *
 * The invariant worth a test, and the reason the geometry was extracted at
 * all: **the text box's whole horizontal extent is inside the canvas for
 * every input**, whatever the text length. `expectOnCanvas` below asserts
 * exactly that and is applied to every case.
 */
import { describe, it, expect } from 'vitest';
import {
  layoutCallout,
  calloutBoxGeometry,
  CALLOUT_FONT_SIZE,
  CALLOUT_CHAR_WIDTH_RATIO,
  CALLOUT_TEXT_OFFSET,
  type CalloutLayout,
} from './Layers';

/** `Layers.tsx`'s own private safe margin, duplicated here as the number the
 *  OUTPUT is checked against rather than re-exported — the same convention
 *  `Graph.test.ts` uses for its tuning constants. */
const MARGIN = 60;

/** The default stack: four cards at the primitive's own defaults. */
const DEFAULTS = { cardW: 620, cardH: 110, gap: 20, n: 4 };
const STACK_H = DEFAULTS.n * DEFAULTS.cardH + (DEFAULTS.n - 1) * DEFAULTS.gap;

interface Canvas {
  width: number;
  height: number;
}

function place(text: string, canvas: Canvas, cardW = DEFAULTS.cardW): CalloutLayout {
  return layoutCallout({
    text,
    cx: canvas.width / 2,
    cy: canvas.height / 2,
    cardW,
    stackH: STACK_H,
    // the second card of four, active — its centre line
    fromY: 1 * (DEFAULTS.cardH + DEFAULTS.gap) - STACK_H / 2 + DEFAULTS.cardH / 2,
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
  });
}

/** The box's left/right edges in WORLD px, given the layout's local anchor
 *  and the width the text will actually take (never more than `maxWidth`). */
function worldExtent(layout: CalloutLayout, text: string, canvas: Canvas) {
  const cx = canvas.width / 2;
  const estimate = text.length * CALLOUT_FONT_SIZE * CALLOUT_CHAR_WIDTH_RATIO;
  const boxW = Math.min(estimate, layout.maxWidth);
  return layout.placement === 'left'
    ? { left: cx + layout.anchor - boxW, right: cx + layout.anchor }
    : { left: cx + layout.anchor, right: cx + layout.anchor + boxW };
}

function expectOnCanvas(layout: CalloutLayout, text: string, canvas: Canvas) {
  const { left, right } = worldExtent(layout, text, canvas);
  expect(left).toBeGreaterThanOrEqual(MARGIN);
  expect(right).toBeLessThanOrEqual(canvas.width - MARGIN);
}

/**
 * The real incident, with its own numbers. c038's canvas was reshaped
 * 1920×1080 → 1252×1016 for the D-348 side-by-side; `c038-tricks`'s callout
 * then flipped left and rendered fully off-frame. A static audit of the same
 * manifest had rated that scene "clean, polish only".
 */
describe('B-240 — the live repro: a 620-wide stack on a 1252-wide canvas', () => {
  const C1252: Canvas = { width: 1252, height: 1016 };
  const TEXT = 'none of it makes inference free'; // the authored callout, 31 chars

  it('the pre-fix picker would have chosen the left side', () => {
    // The exact expression `Layers.tsx` used before this fix.
    const cx = C1252.width / 2;
    const flipsLeft =
      cx + DEFAULTS.cardW / 2 + 314 + TEXT.length * 17 > C1252.width - 60;
    expect(flipsLeft).toBe(true);
  });

  it('and the pre-fix LEFT layout put the text at a negative x', () => {
    // Pre-fix left geometry: the text hung off the arm container (which
    // shrink-wraps to the 240-px arm svg) by `right: 254`, so its right edge
    // landed 14 px left of the arm's start, and `nowrap` grew it leftwards.
    const cx = C1252.width / 2;
    const rightEdge = cx - DEFAULTS.cardW / 2 - 60 - 14;
    const width = TEXT.length * CALLOUT_FONT_SIZE * CALLOUT_CHAR_WIDTH_RATIO;
    expect(rightEdge - width).toBeLessThan(0);
  });

  it('there is genuinely no room on EITHER side, so it goes below', () => {
    const layout = place(TEXT, C1252);
    expect(layout.placement).toBe('below');
    expectOnCanvas(layout, TEXT, C1252);
  });

  it('below the stack it gets the full content box and sets on one line', () => {
    const layout = place(TEXT, C1252);
    expect(layout.maxWidth).toBe(C1252.width - 2 * MARGIN);
    const estimate = TEXT.length * CALLOUT_FONT_SIZE * CALLOUT_CHAR_WIDTH_RATIO;
    expect(estimate).toBeLessThan(layout.maxWidth);
  });

  it('and it clears the bottom of the stack', () => {
    const layout = place(TEXT, C1252);
    expect(layout.top).toBeGreaterThan(STACK_H / 2);
  });
});

describe('B-240 — a RIGHT-hand placement is byte-identical to pre-fix', () => {
  const HD: Canvas = { width: 1920, height: 1080 };

  it('keeps the exact pre-fix offset off the card', () => {
    const text = 'cached';
    const layout = place(text, HD);
    expect(layout.placement).toBe('right');
    // `cardW/2 + 60 + 220 + 34`, the 314 the pre-fix picker hardcoded.
    expect(layout.anchor).toBe(DEFAULTS.cardW / 2 + 314);
    expect(CALLOUT_TEXT_OFFSET).toBe(314);
    expectOnCanvas(layout, text, HD);
  });

  it('keeps the pre-fix `fromY - 18` top', () => {
    const fromY = 1 * (DEFAULTS.cardH + DEFAULTS.gap) - STACK_H / 2 + DEFAULTS.cardH / 2;
    expect(place('cached', HD).top).toBe(fromY - 18);
  });

  it('never wraps a callout that fits — the cap exceeds its own width', () => {
    const text = 'cached';
    const layout = place(text, HD);
    const estimate = text.length * CALLOUT_FONT_SIZE * CALLOUT_CHAR_WIDTH_RATIO;
    expect(layout.maxWidth).toBeGreaterThan(estimate);
  });
});

/**
 * The deliberate behaviour change, recorded so it is not mistaken for a
 * regression. A LEFT placement is not byte-identical, because the pre-fix
 * left geometry was itself wrong: the text hung 14 px inside the arm's own
 * start rather than clear of its tip, which bought it 240 px of apparent
 * room by sitting ON the arm. With the mirror corrected, a callout with no
 * room for the real offset on either side goes `below` instead — on canvas
 * and clear, rather than off-frame (the bug) or over its own arm.
 */
describe('B-240 — a left placement is intentionally NOT what it was', () => {
  const HD: Canvas = { width: 1920, height: 1080 };
  const TEXT = 're-sent on every call'; // this component's own docstring example

  it('pre-fix this flipped left and overlapped its arm; now it goes below', () => {
    const cx = HD.width / 2;
    const flippedLeft = cx + DEFAULTS.cardW / 2 + 314 + TEXT.length * 17 > HD.width - 60;
    expect(flippedLeft).toBe(true);
    const preFixRightEdge = cx - DEFAULTS.cardW / 2 - 60 - 14;
    const armStart = cx - DEFAULTS.cardW / 2 - 60;
    expect(preFixRightEdge).toBeLessThan(armStart); // i.e. on top of the arm

    const layout = place(TEXT, HD);
    expect(layout.placement).toBe('below');
    expectOnCanvas(layout, TEXT, HD);
  });
});

/**
 * B-240's second finding: the picker assumed a flat 17 px/char (0.5em at
 * fontSize 34) where Kalam's real average advance is ~0.42em, so it flipped
 * callouts off a side the text would have fitted on. This is a text length
 * in the ~19% band between the two estimates on a canvas where the right
 * side is the only one with room.
 */
describe('B-240 — the over-wide 0.5em estimate no longer flips a fitting callout', () => {
  // Right-hand room on 1920 with the default stack: 1860 − (960 + 624) = 276.
  // 18 chars: 0.42em → 257 (fits), 0.5em → 306 (the old maths says it does not).
  const HD: Canvas = { width: 1920, height: 1080 };
  const TEXT = 'held for one turn'.padEnd(18, ' ');

  it('the old 17 px/char estimate called it too wide for the right', () => {
    const cx = HD.width / 2;
    const flipsLeft = cx + DEFAULTS.cardW / 2 + 314 + TEXT.length * 17 > HD.width - 60;
    expect(flipsLeft).toBe(true);
  });

  it('measured with Kalam’s real advance it stays on the right', () => {
    const layout = place(TEXT, HD);
    expect(layout.placement).toBe('right');
    expectOnCanvas(layout, TEXT, HD);
  });
});

describe('B-240 — the left side is a true mirror of the right', () => {
  const HD: Canvas = { width: 1920, height: 1080 };

  it('a stack pushed right puts the callout left, clear of its own arm', () => {
    // cx 1400: right-hand room is 1860 − (1400 + 310 + 314) = −164 → none.
    const text = 'the whole prefix';
    const layout = layoutCallout({
      text,
      cx: 1400,
      cy: HD.height / 2,
      cardW: DEFAULTS.cardW,
      stackH: STACK_H,
      fromY: 0,
      canvasWidth: HD.width,
      canvasHeight: HD.height,
    });
    expect(layout.placement).toBe('left');
    // The text's RIGHT edge sits at the mirrored offset — i.e. clear of the
    // arm's tip, not 14 px inside its start the way the pre-fix layout put it.
    expect(layout.anchor).toBe(-(DEFAULTS.cardW / 2 + CALLOUT_TEXT_OFFSET));
    const estimate = text.length * CALLOUT_FONT_SIZE * CALLOUT_CHAR_WIDTH_RATIO;
    expect(1400 + layout.anchor - Math.min(estimate, layout.maxWidth)).toBeGreaterThanOrEqual(
      MARGIN,
    );
  });
});

/**
 * The guarantee the whole extraction exists for. No text length, on any
 * canvas, with any stack width or position, may produce a box that leaves
 * the safe area.
 */
describe('B-240 — on-canvas for every text length, by construction', () => {
  const CASES: Array<{ name: string; canvas: Canvas; cardW: number; cx?: number }> = [
    { name: 'HD, default stack', canvas: { width: 1920, height: 1080 }, cardW: 620 },
    { name: 'the c038 reshape', canvas: { width: 1252, height: 1016 }, cardW: 620 },
    { name: 'vertical 9:16', canvas: { width: 1080, height: 1920 }, cardW: 620 },
    { name: 'a stack wider than the frame', canvas: { width: 800, height: 800 }, cardW: 1200 },
    { name: 'a square, narrow stack', canvas: { width: 1000, height: 1000 }, cardW: 200 },
  ];

  for (const c of CASES) {
    for (const len of [1, 8, 20, 31, 60, 140, 400]) {
      it(`${c.name}, ${len} chars`, () => {
        const text = 'x'.repeat(len);
        const layout = layoutCallout({
          text,
          cx: c.cx ?? c.canvas.width / 2,
          cy: c.canvas.height / 2,
          cardW: c.cardW,
          stackH: STACK_H,
          fromY: 0,
          canvasWidth: c.canvas.width,
          canvasHeight: c.canvas.height,
        });
        expect(layout.maxWidth).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(layout.top)).toBe(true);
        expectOnCanvas(layout, text, c.canvas);
      });
    }
  }

  it('a 400-char callout on the c038 canvas wraps instead of overflowing', () => {
    const canvas: Canvas = { width: 1252, height: 1016 };
    const text = 'x'.repeat(400);
    const layout = place(text, canvas);
    const estimate = text.length * CALLOUT_FONT_SIZE * CALLOUT_CHAR_WIDTH_RATIO;
    expect(estimate).toBeGreaterThan(layout.maxWidth);
    expectOnCanvas(layout, text, canvas);
  });
});

describe('B-240 — the `below` fallback cannot run off the bottom either', () => {
  it('a short canvas pulls the block back inside the bottom margin', () => {
    const canvas: Canvas = { width: 1252, height: 420 };
    const text = 'none of it makes inference free';
    const layout = place(text, canvas);
    expect(layout.placement).toBe('below');
    const worldTop = canvas.height / 2 + layout.top;
    expect(worldTop).toBeGreaterThanOrEqual(60);
    // one line at 34 px, generously 1.5× — still inside the bottom margin
    expect(worldTop + CALLOUT_FONT_SIZE * 1.5).toBeLessThanOrEqual(canvas.height - 60);
  });
});

describe("calloutBoxGeometry (B-244)", () => {
  const layouts: CalloutLayout[] = [
    { placement: "right", anchor: 324, top: -18, maxWidth: 400 },
    { placement: "left", anchor: -324, top: -18, maxWidth: 400 },
    { placement: "below", anchor: -566, top: 120, maxWidth: 1132 },
  ];

  /// The regression. Pre-fix, `width` was set only for `below`; the other two
  /// fell back to shrink-to-fit inside a zero-width origin container, and
  /// `overflowWrap: "anywhere"` then broke the text to ONE GLYPH PER LINE —
  /// a vertical column running off the bottom of the frame. A cap is not a
  /// width.
  it("every placement gets a real width, not just a cap", () => {
    for (const layout of layouts) {
      const g = calloutBoxGeometry(layout);
      expect(g.width, `${layout.placement} must have an explicit width`).toBe(layout.maxWidth);
      expect(typeof g.width).toBe("number");
      expect(g.width).toBeGreaterThan(0);
      // The cap must still be there — it is what bounds a long string.
      expect(g.maxWidth).toBe(layout.maxWidth);
    }
  });

  it("anchors the correct edge per placement", () => {
    const right = calloutBoxGeometry(layouts[0]);
    expect(right.left).toBe(324);
    expect(right.right).toBeUndefined();
    expect(right.textAlign).toBe("left");

    // `left` anchors the box's RIGHT edge, and the origin is zero-width, so
    // a local x of -324 becomes `right: 324`.
    const left = calloutBoxGeometry(layouts[1]);
    expect(left.left).toBeUndefined();
    expect(left.right).toBe(324);
    expect(left.textAlign).toBe("right");

    const below = calloutBoxGeometry(layouts[2]);
    expect(below.left).toBe(-566);
    expect(below.textAlign).toBe("center");
  });
});
