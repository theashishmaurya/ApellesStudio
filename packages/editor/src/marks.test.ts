// @apelles/editor — B-348: the In / Out marks' rules (`marks.ts`).
import { describe, expect, it } from 'vitest';

import { applyMarks, markedRange } from './marks';

const NONE = { inPoint: null, outPoint: null };

describe('applyMarks', () => {
  it('sets each side alone and clamps to the timeline', () => {
    expect(applyMarks(NONE, { inPoint: 30 }, 270)).toEqual({ inPoint: 30, outPoint: null });
    expect(applyMarks(NONE, { outPoint: 9999 }, 270)).toEqual({ inPoint: null, outPoint: 269 });
    expect(applyMarks(NONE, { inPoint: -5 }, 270)).toEqual({ inPoint: 0, outPoint: null });
  });

  it('an empty timeline has no marks', () => {
    expect(applyMarks(NONE, { inPoint: 3 }, 0)).toEqual(NONE);
  });

  it('an In after the Out drops the Out, and an Out before the In drops the In', () => {
    expect(applyMarks({ inPoint: 10, outPoint: 50 }, { inPoint: 80 }, 270)).toEqual({ inPoint: 80, outPoint: null });
    expect(applyMarks({ inPoint: 40, outPoint: 90 }, { outPoint: 20 }, 270)).toEqual({ inPoint: null, outPoint: 20 });
  });

  it('both at once are kept ordered', () => {
    expect(applyMarks(NONE, { inPoint: 60, outPoint: 30 }, 270)).toEqual({ inPoint: 30, outPoint: 60 });
  });

  it('null clears a side, undefined leaves it', () => {
    expect(applyMarks({ inPoint: 10, outPoint: 50 }, { inPoint: null }, 270)).toEqual({ inPoint: null, outPoint: 50 });
    expect(applyMarks({ inPoint: 10, outPoint: 50 }, {}, 270)).toEqual({ inPoint: 10, outPoint: 50 });
    expect(applyMarks({ inPoint: 10, outPoint: 50 }, { inPoint: null, outPoint: null }, 270)).toEqual(NONE);
  });
});

describe('markedRange', () => {
  it('is inclusive, runs an absent side to that end, and is null with no marks', () => {
    expect(markedRange({ inPoint: 30, outPoint: 60 }, 270)).toEqual({ start: 30, end: 60 });
    expect(markedRange({ inPoint: 30, outPoint: null }, 270)).toEqual({ start: 30, end: 269 });
    expect(markedRange({ inPoint: null, outPoint: 60 }, 270)).toEqual({ start: 0, end: 60 });
    expect(markedRange(NONE, 270)).toBeNull();
  });
});
