import { describe, expect, it } from 'vitest';
import { followScrollLeft, FOLLOW_PAGE_LEAD_PX, seekFollowScrollLeft } from './playbackFollow';

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

describe('seekFollowScrollLeft (B-359 item 6)', () => {
  it('leaves a visible playhead alone', () => {
    expect(seekFollowScrollLeft({ ...base, scrollLeft: 2000, frame: 25 * 25 })).toBeNull();
  });
  it('centres a jump past the right edge', () => {
    // x = 32 + 60 s * 100 = 6032; centred in a 1000 px viewport
    expect(seekFollowScrollLeft({ ...base, frame: 25 * 60 })).toBe(6032 - 500);
  });
  it('centres a jump left of the view (the owner\'s 0:06 seek with the view at 3:55)', () => {
    expect(seekFollowScrollLeft({ ...base, scrollLeft: 23500, frame: 25 * 6 })).toBe(632 - 500);
  });
  it('clamps at the start of the timeline', () => {
    expect(seekFollowScrollLeft({ ...base, scrollLeft: 5000, frame: 0 })).toBe(0);
  });
  it('does nothing before the viewport is measured', () => {
    expect(seekFollowScrollLeft({ ...base, viewportWidth: 0, frame: 25 * 99 })).toBeNull();
  });
});
