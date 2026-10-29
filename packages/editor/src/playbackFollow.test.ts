import { describe, expect, it } from 'vitest';
import { followScrollLeft, FOLLOW_PAGE_LEAD_PX } from './playbackFollow';

const base = { fps: 25, pxPerSec: 100, scrollLeft: 0, viewportWidth: 1000, startLeftPx: 32 };

describe('followScrollLeft (B-326)', () => {
  it('leaves a visible playhead alone', () => {
    expect(followScrollLeft({ ...base, frame: 25 * 3 })).toBeNull();
  });
  it('pages forward when the playhead passes the right edge', () => {
    expect(followScrollLeft({ ...base, frame: 25 * 20 })).toBe(20 * 100 - FOLLOW_PAGE_LEAD_PX);
  });
  it('pages back when the playhead is left of the view', () => {
    expect(followScrollLeft({ ...base, scrollLeft: 3000, frame: 25 * 5 })).toBe(5 * 100 - FOLLOW_PAGE_LEAD_PX);
  });
  it('never returns a negative scroll', () => {
    expect(followScrollLeft({ ...base, scrollLeft: 500, frame: 0 })).toBe(0);
  });
  it('does nothing before the viewport is measured', () => {
    expect(followScrollLeft({ ...base, viewportWidth: 0, frame: 25 * 99 })).toBeNull();
  });
});
