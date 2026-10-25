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
  layersTypeScale,
  CALLOUT_FONT_SIZE,
  CALLOUT_CHAR_WIDTH_RATIO,
  CALLOUT_TEXT_OFFSET,
  LAYERS_BASE_CARD_WIDTH,
  LAYERS_BASE_CARD_HEIGHT,
  LAYERS_LABEL_FONT_SIZE,
  LAYERS_SUBLABEL_FONT_SIZE,
  LAYERS_TYPE_MIN_FONT_SIZE,
  LAYERS_PERSPECTIVE,
  LAYERS_MAX_LIFT,
  LAYERS_LIFT_FRAMES,
  activeLift,
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

/**
 * B-239, piece (2) for `layers` — the card label (40), sublabel (24) and
 * callout (34) were baked in px, so D-347's canvas reflow shrank the CARDS
 * (`cardW` by `sx`, `cardH` by `sy`) and the authored captions around them
 * (`text.size` by `su`) while the cards' own type stayed exactly where it
 * was. Fixed by `layersTypeScale`: one multiplier from the card's own box
 * against the box those three sizes were authored for.
 *
 * The same treatment, and the same reasoning, as `Plot.test.ts`'s
 * `plotTypeScale` cases — kept in that order so the two read together.
 */
describe('B-239 — the authored card is unchanged', () => {
  /** The three sizes `Layers.tsx` drew before this fix (the callout's 34 was
   *  already a named constant, from B-240). Asserted here so the named
   *  constants cannot silently drift from the rendering this primitive was
   *  signed off at. */
  const PRE_FIX_SIZES = { label: 40, sublabel: 24, callout: 34 } as const;

  it('the named constants are the three sizes that were there', () => {
    expect(LAYERS_LABEL_FONT_SIZE).toBe(PRE_FIX_SIZES.label);
    expect(LAYERS_SUBLABEL_FONT_SIZE).toBe(PRE_FIX_SIZES.sublabel);
    expect(CALLOUT_FONT_SIZE).toBe(PRE_FIX_SIZES.callout);
  });

  it('the base box is the primitive’s own default card', () => {
    expect(LAYERS_BASE_CARD_WIDTH).toBe(DEFAULTS.cardW);
    expect(LAYERS_BASE_CARD_HEIGHT).toBe(DEFAULTS.cardH);
  });

  it('the scale is exactly 1 there', () => {
    expect(layersTypeScale(LAYERS_BASE_CARD_WIDTH, LAYERS_BASE_CARD_HEIGHT)).toBe(1);
  });

  it('so every role renders at exactly its pre-fix size', () => {
    const s = layersTypeScale(LAYERS_BASE_CARD_WIDTH, LAYERS_BASE_CARD_HEIGHT);
    expect(LAYERS_LABEL_FONT_SIZE * s).toBe(PRE_FIX_SIZES.label);
    expect(LAYERS_SUBLABEL_FONT_SIZE * s).toBe(PRE_FIX_SIZES.sublabel);
    expect(CALLOUT_FONT_SIZE * s).toBe(PRE_FIX_SIZES.callout);
  });

  it('the item COUNT and the gap are not part of the box', () => {
    // A fifth card makes the stack taller; it does not make a label smaller.
    expect(layersTypeScale(DEFAULTS.cardW, DEFAULTS.cardH)).toBe(1);
    expect(STACK_H).toBeGreaterThan(DEFAULTS.cardH); // the stack is not the card
  });
});

/**
 * The real incident, with its own numbers. c038's canvas went 1920×1080 →
 * 1252×1016, so the reflow scaled `cardW` by `sx = 0.6521` and `cardH` by
 * `sy = 0.9407`, and an authored supporting caption (`text.size: 34`) by
 * `su = sx` to 22.2 px — while the card's own label stayed at 40.
 */
describe('B-239 — the c038 reflow, with its own factors', () => {
  const SX = 1252 / 1920; // 0.6521
  const SY = 1016 / 1080; // 0.9407
  const W = LAYERS_BASE_CARD_WIDTH * SX;
  const H = LAYERS_BASE_CARD_HEIGHT * SY;
  /** An authored supporting caption, reflowed by `su` (= `sx` here) — D-372. */
  const CAPTION_AFTER = 34 * SX;

  it('the card’s type shrinks with the card', () => {
    expect(layersTypeScale(W, H)).toBeCloseTo(SX, 10);
    expect(LAYERS_LABEL_FONT_SIZE * layersTypeScale(W, H)).toBeCloseTo(26.08, 2);
  });

  it('the inversion is gone: the label/caption ratio is the authored one', () => {
    const label = LAYERS_LABEL_FONT_SIZE * layersTypeScale(W, H);
    // pre-fix: a 40 px label against a 22.2 px caption — 1.80×, where the
    // author had set 40/34 = 1.18×.
    expect(LAYERS_LABEL_FONT_SIZE / CAPTION_AFTER).toBeCloseTo(1.8, 2);
    expect(label / CAPTION_AFTER).toBeCloseTo(LAYERS_LABEL_FONT_SIZE / CALLOUT_FONT_SIZE, 10);
  });

  it('and the hierarchy inside the stack is preserved exactly', () => {
    const s = layersTypeScale(W, H);
    expect(LAYERS_LABEL_FONT_SIZE * s).toBeGreaterThan(CALLOUT_FONT_SIZE * s);
    expect(CALLOUT_FONT_SIZE * s).toBeGreaterThan(LAYERS_SUBLABEL_FONT_SIZE * s);
    expect((LAYERS_LABEL_FONT_SIZE * s) / (LAYERS_SUBLABEL_FONT_SIZE * s)).toBeCloseTo(40 / 24, 10);
  });
});

describe('B-239 — `min` of the two ratios, because type cannot stretch', () => {
  it('a card that only got narrower scales by the width ratio', () => {
    expect(layersTypeScale(LAYERS_BASE_CARD_WIDTH * 0.8, LAYERS_BASE_CARD_HEIGHT)).toBeCloseTo(
      0.8,
      10,
    );
  });

  it('a card that only got shorter scales by the height ratio', () => {
    expect(layersTypeScale(LAYERS_BASE_CARD_WIDTH, LAYERS_BASE_CARD_HEIGHT * 0.8)).toBeCloseTo(
      0.8,
      10,
    );
  });

  it('a wider-but-shorter card takes the axis that shrank, not an average', () => {
    expect(layersTypeScale(LAYERS_BASE_CARD_WIDTH * 2, LAYERS_BASE_CARD_HEIGHT * 0.7)).toBeCloseTo(
      0.7,
      10,
    );
  });

  it('a uniformly bigger card gets proportionally bigger type — no cap', () => {
    expect(layersTypeScale(LAYERS_BASE_CARD_WIDTH * 2, LAYERS_BASE_CARD_HEIGHT * 2)).toBe(2);
    expect(layersTypeScale(LAYERS_BASE_CARD_WIDTH * 10, LAYERS_BASE_CARD_HEIGHT * 10)).toBe(10);
  });

  it('a card authored non-default is already scaled — the other half of the fix', () => {
    // 760×150, the `layers` card in `@apelles/motion`'s own reflow fixture:
    // min(1.2258, 1.3636). Its type was never proportional to it before.
    expect(layersTypeScale(760, 150)).toBeCloseTo(760 / 620, 10);
  });
});

describe('B-239 — the legibility floor', () => {
  it('does not bind at the c038 reflow, or anywhere near an ordinary one', () => {
    expect(
      layersTypeScale(LAYERS_BASE_CARD_WIDTH * 0.6521, LAYERS_BASE_CARD_HEIGHT * 0.9407),
    ).toBeCloseTo(0.6521, 10);
    // it starts to bind only once the smallest role would drop under 14 px
    expect(LAYERS_TYPE_MIN_FONT_SIZE / LAYERS_SUBLABEL_FONT_SIZE).toBeCloseTo(0.5833, 4);
  });

  it('the smallest role never goes under the floor, however small the card', () => {
    for (const box of [
      [10, 10],
      [1, 110],
      [620, 1],
      [0.001, 0.001],
    ] as Array<[number, number]>) {
      expect(LAYERS_SUBLABEL_FONT_SIZE * layersTypeScale(box[0], box[1])).toBeGreaterThanOrEqual(
        LAYERS_TYPE_MIN_FONT_SIZE,
      );
    }
  });

  it('the floor lands exactly on the floor font size for the sublabel role', () => {
    expect(LAYERS_SUBLABEL_FONT_SIZE * layersTypeScale(1, 1)).toBeCloseTo(
      LAYERS_TYPE_MIN_FONT_SIZE,
      10,
    );
  });
});

/**
 * `cardW`/`cardH` reach this primitive through a `.passthrough()` schema
 * layer and are never validated item by item, so a hand-authored
 * `"cardW": "620"` really can arrive as a non-number — the same guard
 * `plotTypeScale` needs, for the same reason: a `NaN` font size silently
 * drops the text it was for.
 */
describe('B-239 — a non-numeric or degenerate card falls back to 1, never NaN', () => {
  const BAD: Array<[unknown, unknown]> = [
    [NaN, 110],
    [620, NaN],
    [Infinity, 110],
    [620, -Infinity],
    [0, 110],
    [620, 0],
    [-620, -110],
  ];
  for (const [w, h] of BAD) {
    it(`${String(w)} × ${String(h)}`, () => {
      const s = layersTypeScale(w as number, h as number);
      expect(Number.isFinite(s)).toBe(true);
      expect(s).toBe(1);
    });
  }
});

/**
 * The callout is the one role whose size feeds a LAYOUT decision — B-240's
 * placement budget is in px, and `layoutCallout` takes the size as an
 * argument precisely so it can be told. `Layers` now passes the SCALED size,
 * so the size the box is laid out for and the size it is drawn at cannot
 * drift apart.
 */
describe('B-239 — the callout’s placement is measured at the size it will render', () => {
  const HD: Canvas = { width: 1920, height: 1080 };

  /** `cardW` is held at the default throughout, so the only thing varying
   *  across these cases is the font size. */
  function placeAt(text: string, fontSize?: number): CalloutLayout {
    return layoutCallout({
      text,
      cx: HD.width / 2,
      cy: HD.height / 2,
      cardW: DEFAULTS.cardW,
      stackH: STACK_H,
      fromY: 0,
      canvasWidth: HD.width,
      canvasHeight: HD.height,
      ...(fontSize === undefined ? {} : { fontSize }),
    });
  }

  it('at the default card the passed size IS the default, so nothing moves', () => {
    const text = 'none of it makes inference free';
    const s = layersTypeScale(LAYERS_BASE_CARD_WIDTH, LAYERS_BASE_CARD_HEIGHT);
    expect(placeAt(text, CALLOUT_FONT_SIZE * s)).toEqual(placeAt(text));
  });

  it('a squat card shrinks the text, so a callout can now fit on a side', () => {
    // 25 chars at 34 px needs 357 px and the right side has 276, so it falls
    // `below`; the same text at 0.6× needs 214 and fits on the right.
    const text = 'x'.repeat(25);
    const s = layersTypeScale(LAYERS_BASE_CARD_WIDTH, LAYERS_BASE_CARD_HEIGHT * 0.6);
    expect(s).toBeCloseTo(0.6, 10);
    expect(placeAt(text).placement).toBe('below');
    expect(placeAt(text, CALLOUT_FONT_SIZE * s).placement).toBe('right');
  });

  it('and the `below` block’s predicted height shrinks with it too', () => {
    const short: Canvas = { width: 1252, height: 420 };
    const text = 'x'.repeat(400);
    const at = (fontSize?: number) =>
      layoutCallout({
        text,
        cx: short.width / 2,
        cy: short.height / 2,
        cardW: DEFAULTS.cardW,
        stackH: STACK_H,
        fromY: 0,
        canvasWidth: short.width,
        canvasHeight: short.height,
        ...(fontSize === undefined ? {} : { fontSize }),
      });
    // A shorter predicted block is pulled back up less hard by the bottom
    // margin, so it sits LOWER — closer to where it wanted to be.
    expect(at().placement).toBe('below');
    expect(at(CALLOUT_FONT_SIZE * 0.6).top).toBeGreaterThan(at().top);
  });
});

describe("activeLift (B-260)", () => {
  it("never grows the lit card past the gap to its neighbours", () => {
    for (const [cardH, gap] of [[104, 22], [110, 20], [80, 8], [200, 60]]) {
      const z = activeLift(100, cardH, gap);
      const k = LAYERS_PERSPECTIVE / (LAYERS_PERSPECTIVE - z);
      expect((cardH * (k - 1)) / 2).toBeLessThanOrEqual(gap);
      expect(z).toBeLessThanOrEqual(LAYERS_MAX_LIFT);
    }
  });
  it("eases in from zero rather than snapping", () => {
    expect(activeLift(0, 104, 22)).toBe(0);
    expect(activeLift(LAYERS_LIFT_FRAMES / 2, 104, 22)).toBeGreaterThan(0);
    expect(activeLift(LAYERS_LIFT_FRAMES / 2, 104, 22)).toBeLessThan(activeLift(LAYERS_LIFT_FRAMES, 104, 22));
  });
});
