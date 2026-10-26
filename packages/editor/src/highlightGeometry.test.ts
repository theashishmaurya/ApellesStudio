// D-396 — the highlight-box <-> composition mapping the viewer overlay uses.
import { describe, expect, it } from 'vitest';
import { compositionToHighlight, highlightToComposition } from './highlightGeometry';

const placement = { left: 0.2, top: 0.1, width: 0.6, height: 0.4 };

describe('highlight geometry', () => {
  it('an uncropped box scales into the placement box', () => {
    const out = highlightToComposition([0.5, 0.25, 1, 0.75], placement);
    expect(out?.left).toBeCloseTo(0.5);
    expect(out?.top).toBeCloseTo(0.2);
    expect(out?.width).toBeCloseTo(0.3);
    expect(out?.height).toBeCloseTo(0.2);
  });

  it('a crop shifts and stretches it: the box inside the kept region lands relative to it', () => {
    // Left 25% and right 25% cropped: the placement box shows u in [0.25, 0.75].
    const out = highlightToComposition([0.25, 0, 0.75, 1], placement, { left: 0.25, right: 0.25 });
    expect(out?.left).toBeCloseTo(0.2);
    expect(out?.width).toBeCloseTo(0.6);
  });

  it('round-trips through the inverse', () => {
    const crop = { left: 0.1, top: 0.2, right: 0.05, bottom: 0.15 };
    const box: [number, number, number, number] = [0.3, 0.4, 0.7, 0.6];
    const comp = highlightToComposition(box, placement, crop);
    expect(comp).not.toBeNull();
    const back = compositionToHighlight(comp as NonNullable<typeof comp>, placement, crop);
    back?.forEach((v, i) => expect(v).toBeCloseTo(box[i]));
  });

  it('clamps to the image and refuses a fully cropped clip', () => {
    const wide = compositionToHighlight({ left: -1, top: -1, width: 5, height: 5 }, placement);
    expect(wide).toEqual([0, 0, 1, 1]);
    expect(highlightToComposition([0, 0, 1, 1], placement, { left: 0.5, right: 0.5 })).toBeNull();
  });
});
