// @apelles/editor — unit tests for marquee-select's pure half (`marquee.ts`,
// roadmap item 12 Phase 2, D-137).
//
// Two things are under test here, and they matter for different reasons:
//
// 1. **The intersection math** — a clip's bounding box against the marquee
//    rect, on both axes, for partial overlap / full containment / no overlap /
//    edge-touch, plus the row-band arithmetic that decides which TRACKS a rect
//    reaches. Ordinary, checkable geometry.
//
// 2. **The gesture-dispatch discrimination** — `canStartMarquee`, the single
//    predicate that keeps a marquee from ever beginning on a `pointerdown`
//    that `@dnd-kit/core`'s `PointerSensor` would also claim. That is the one
//    thing this timeline has genuinely burned six consecutive decisions on
//    (D-094–D-100), so it is tested against a real fake of `Element.closest`
//    that walks an explicit ancestor chain, not by asserting the selector
//    string's own text.
//
// **What these tests are NOT.** This package's vitest runs in a bare `node`
// environment (`vitest.config.ts`) — there is no DOM here, so `closest` is a
// hand-written stand-in over a declared ancestor list, and no real
// `PointerEvent` is ever dispatched at a real `TimelinePane`. That gap is
// stated plainly in D-137's own verification section rather than papered over.
import { describe, expect, it } from 'vitest';

import {
  MARQUEE_MIN_DRAG_PX,
  canStartMarquee,
  clipsInMarquee,
  composeMarqueeSelection,
  marqueeActivated,
  marqueeAnchorFromPoint,
  marqueeOverlayBox,
  marqueeRect,
  type MarqueeHitTarget,
  type MarqueeViewport,
} from './marquee';
import { type Clip, type Timeline } from './timeline';

function clip(id: string, start_frame: number, duration: number): Clip {
  return {
    id,
    name: id,
    source_path: `/media/${id}.mov`,
    source_start: 0,
    duration,
    source_len: duration,
    start_frame,
  };
}

/** Track 0: `a` [0,100), `b` [200,300). Track 1: `c` [50,150). Track 2: `d`
 *  [1000,1100) — far away, so "no overlap" cases are unambiguous. */
function fixture(): Timeline {
  return {
    id: 't1',
    name: 'Timeline',
    tracks: [
      { kind: 'video', clips: [clip('a', 0, 100), clip('b', 200, 100)] },
      { kind: 'video', clips: [clip('c', 50, 100)] },
      { kind: 'audio', clips: [clip('d', 1000, 100)] },
    ],
  };
}

/** A stand-in for a real DOM node's `closest`, for vitest's `node`
 *  environment. `chain` is this node's own selectors plus every ancestor's, in
 *  order — exactly what a real `closest` walks. */
function target(...chain: string[]): MarqueeHitTarget {
  return {
    closest(selector: string) {
      const wanted = selector.split(',').map((s) => s.trim());
      return chain.some((c) => wanted.includes(c)) ? {} : null;
    },
  };
}

describe('canStartMarquee — empty-space vs. clip pointerdown discrimination', () => {
  it('starts on genuinely empty edit-area canvas', () => {
    expect(canStartMarquee(0, target('.timeline-editor-edit-area'))).toBe(true);
  });

  it('refuses a pointerdown on the dnd-kit draggable clip body', () => {
    // The real DOM shape: our label div, inside `ClipBody` (the one
    // `useDraggable` node), inside the library's action wrapper.
    expect(
      canStartMarquee(0, target('[data-chroma-clip-drag]', '.timeline-editor-action', '.timeline-editor-edit-row')),
    ).toBe(false);
  });

  it('refuses even if only the dnd-kit attribute is present', () => {
    // The load-bearing assertion: the guard is "is a dnd-kit draggable on this
    // event's path", independent of the timeline library's own classes. If
    // `ClipBody` ever moved out from under `.timeline-editor-action`, this
    // still holds.
    expect(canStartMarquee(0, target('[data-chroma-clip-drag]'))).toBe(false);
  });

  it("refuses the library's own edge-trim handles (an action descendant)", () => {
    expect(canStartMarquee(0, target('.timeline-editor-action-left-stretch', '.timeline-editor-action'))).toBe(false);
  });

  it('refuses the ruler and the playhead cursor', () => {
    expect(canStartMarquee(0, target('.timeline-editor-time-area'))).toBe(false);
    expect(canStartMarquee(0, target('.timeline-editor-cursor'))).toBe(false);
    expect(canStartMarquee(0, target('.timeline-editor-cursor-area'))).toBe(false);
  });

  it('honours the explicit opt-out attribute', () => {
    expect(canStartMarquee(0, target('[data-chroma-no-marquee]'))).toBe(false);
  });

  it('refuses a non-primary button and a missing target', () => {
    expect(canStartMarquee(1, target('.timeline-editor-edit-area'))).toBe(false);
    expect(canStartMarquee(2, target('.timeline-editor-edit-area'))).toBe(false);
    expect(canStartMarquee(0, null)).toBe(false);
  });
});

describe('marqueeActivated — the minimum-drag threshold', () => {
  it('a bare click (zero movement) never activates', () => {
    expect(marqueeActivated(0, 0)).toBe(false);
  });

  it('jitter below the threshold never activates', () => {
    expect(marqueeActivated(2, 2)).toBe(false); // ~2.83px
    expect(marqueeActivated(-3, 0)).toBe(false);
  });

  it('activates at exactly the threshold, in any direction', () => {
    expect(marqueeActivated(MARQUEE_MIN_DRAG_PX, 0)).toBe(true);
    expect(marqueeActivated(0, -MARQUEE_MIN_DRAG_PX)).toBe(true);
    expect(marqueeActivated(-30, 12)).toBe(true);
  });

  it('measures euclidean distance, matching the PointerSensor constraint', () => {
    // 3-4-5: neither axis alone reaches 4, the diagonal is 5.
    expect(marqueeActivated(3, 4)).toBe(true);
  });
});

describe('marqueeRect', () => {
  it('normalises a drag made up-and-left', () => {
    expect(marqueeRect({ frame: 300, row: 2.5 }, { frame: 100, row: 0.5 })).toEqual({
      frameStart: 100,
      frameEnd: 300,
      rowStart: 0.5,
      rowEnd: 2.5,
    });
  });

  it('produces the same rect for the reverse drag', () => {
    const a = { frame: 10, row: 0.2 };
    const b = { frame: 90, row: 1.8 };
    expect(marqueeRect(a, b)).toEqual(marqueeRect(b, a));
  });
});

describe('clipsInMarquee — bounding-box intersection', () => {
  const tl = fixture();

  it('selects a clip the rect only partially overlaps', () => {
    // [50,80) clips into `a` [0,100) but never reaches `b` [200,300).
    expect(clipsInMarquee(tl, { frameStart: 50, frameEnd: 80, rowStart: 0, rowEnd: 1 })).toEqual([
      { track: 0, id: 'a' },
    ]);
  });

  it('selects a clip fully contained by the rect', () => {
    expect(clipsInMarquee(tl, { frameStart: -50, frameEnd: 150, rowStart: 0, rowEnd: 1 })).toEqual([
      { track: 0, id: 'a' },
    ]);
  });

  it('selects a clip that fully contains the rect', () => {
    expect(clipsInMarquee(tl, { frameStart: 210, frameEnd: 220, rowStart: 0.2, rowEnd: 0.4 })).toEqual([
      { track: 0, id: 'b' },
    ]);
  });

  it('selects nothing when the rect misses on the time axis', () => {
    expect(clipsInMarquee(tl, { frameStart: 120, frameEnd: 180, rowStart: 0, rowEnd: 1 })).toEqual([]);
  });

  it('selects nothing when the rect misses on the track axis', () => {
    // These frames overlap `a`, `b` AND `c` — all three would be hits but for
    // the row band, which sits entirely inside track 2, whose only clip (`d`,
    // at [1000,1100)) is far outside the frame range. An empty result here is
    // therefore real evidence the row filter runs, not a vacuous pass.
    expect(clipsInMarquee(tl, { frameStart: 0, frameEnd: 300, rowStart: 2.1, rowEnd: 2.9 })).toEqual([]);
  });

  it('a merely-touching edge does not select (open-interval overlap)', () => {
    // `a` is [0,100): a rect starting exactly at 100 shares a boundary, no area.
    expect(clipsInMarquee(tl, { frameStart: 100, frameEnd: 150, rowStart: 0, rowEnd: 1 })).toEqual([]);
    // …and one ending exactly at 0 likewise.
    expect(clipsInMarquee(tl, { frameStart: -50, frameEnd: 0, rowStart: 0, rowEnd: 1 })).toEqual([]);
  });

  it('spans tracks, returning hits in track then clip order', () => {
    expect(clipsInMarquee(tl, { frameStart: 0, frameEnd: 400, rowStart: 0, rowEnd: 2 })).toEqual([
      { track: 0, id: 'a' },
      { track: 0, id: 'b' },
      { track: 1, id: 'c' },
    ]);
  });

  it('crossing a row seam by a sliver catches BOTH tracks', () => {
    // The bug fractional rows exist to prevent: floor(0.9)===0 and
    // floor(1.05)===1 would work here, but floor-both-ends drops track 1
    // whenever the bottom edge lands exactly on the boundary — see below.
    expect(clipsInMarquee(tl, { frameStart: 60, frameEnd: 70, rowStart: 0.9, rowEnd: 1.05 })).toEqual([
      { track: 0, id: 'a' },
      { track: 1, id: 'c' },
    ]);
  });

  it('a rect ending exactly on a row boundary does not leak into the next track', () => {
    expect(clipsInMarquee(tl, { frameStart: 60, frameEnd: 70, rowStart: 0.2, rowEnd: 1 })).toEqual([
      { track: 0, id: 'a' },
    ]);
  });

  it('selects clips on a locked track, matching what a plain click already does', () => {
    const locked: Timeline = {
      ...tl,
      tracks: [{ ...tl.tracks[0], locked: true }, tl.tracks[1], tl.tracks[2]],
    };
    expect(clipsInMarquee(locked, { frameStart: 0, frameEnd: 400, rowStart: 0, rowEnd: 1 })).toEqual([
      { track: 0, id: 'a' },
      { track: 0, id: 'b' },
    ]);
  });

  it('is empty for a null timeline', () => {
    expect(clipsInMarquee(null, { frameStart: 0, frameEnd: 999, rowStart: 0, rowEnd: 9 })).toEqual([]);
  });
});

describe('composeMarqueeSelection — modifier-key composition', () => {
  const prev = [
    { track: 0, id: 'a' },
    { track: 1, id: 'c' },
  ];
  const hits = [
    { track: 0, id: 'b' },
    { track: 1, id: 'c' },
  ];

  it('a plain marquee replaces the whole selection', () => {
    expect(composeMarqueeSelection(prev, hits, false)).toEqual([
      { track: 0, id: 'b' },
      { track: 1, id: 'c' },
    ]);
  });

  it('a plain marquee that hits nothing clears the selection', () => {
    expect(composeMarqueeSelection(prev, [], false)).toEqual([]);
  });

  it('an additive marquee unions onto the existing selection, order preserved', () => {
    expect(composeMarqueeSelection(prev, hits, true)).toEqual([
      { track: 0, id: 'a' },
      { track: 1, id: 'c' },
      { track: 0, id: 'b' },
    ]);
  });

  it('an additive marquee never toggles an already-selected clip off', () => {
    // Sweeping over a clip that is already selected keeps it selected — the
    // deliberate asymmetry with cmd-CLICK, which does toggle.
    expect(composeMarqueeSelection(prev, [{ track: 0, id: 'a' }], true)).toEqual(prev);
  });

  it('an additive marquee that hits nothing leaves the selection untouched', () => {
    expect(composeMarqueeSelection(prev, [], true)).toEqual(prev);
  });

  it('distinguishes the same clip id on two different tracks', () => {
    // `Clip.id` only promises stability, never global uniqueness (D-107).
    expect(composeMarqueeSelection([{ track: 0, id: 'x' }], [{ track: 1, id: 'x' }], true)).toEqual([
      { track: 0, id: 'x' },
      { track: 1, id: 'x' },
    ]);
  });

  it('returns fresh objects, never the caller’s own array or elements', () => {
    const out = composeMarqueeSelection(prev, hits, true);
    expect(out).not.toBe(prev);
    expect(out[0]).not.toBe(prev[0]);
  });
});

describe('pixel ↔ timeline conversion', () => {
  const v: MarqueeViewport = {
    fps: 24,
    pxPerSec: 48, // 2px per frame
    scrollLeft: 0,
    scrollTop: 0,
    startLeftPx: 20,
    rulerPx: 42,
    rowHeight: 52,
  };

  it('maps an edit-area point to a frame and a fractional row', () => {
    expect(marqueeAnchorFromPoint(20, 42, v)).toEqual({ frame: 0, row: 0 });
    expect(marqueeAnchorFromPoint(120, 42 + 26, v)).toEqual({ frame: 50, row: 0.5 });
  });

  it('accounts for scroll on both axes', () => {
    const scrolled = { ...v, scrollLeft: 100, scrollTop: 52 };
    expect(marqueeAnchorFromPoint(20, 42, scrolled)).toEqual({ frame: 50, row: 1 });
  });

  it('marqueeOverlayBox is the exact inverse of marqueeAnchorFromPoint', () => {
    const a = marqueeAnchorFromPoint(60, 100, v);
    const b = marqueeAnchorFromPoint(300, 220, v);
    const box = marqueeOverlayBox(marqueeRect(a, b), v);
    expect(box).toEqual({ left: 60, top: 100, width: 240, height: 120 });
  });

  it('the overlay follows a mid-drag scroll, since the rect is in timeline units', () => {
    const rect = { frameStart: 0, frameEnd: 48, rowStart: 0, rowEnd: 1 };
    const before = marqueeOverlayBox(rect, v);
    const after = marqueeOverlayBox(rect, { ...v, scrollLeft: 96, scrollTop: 52 });
    expect(after.left).toBe(before.left - 96);
    expect(after.top).toBe(before.top - 52);
    // …and it does not change SIZE just because the view scrolled.
    expect(after.width).toBe(before.width);
    expect(after.height).toBe(before.height);
  });

  it('the overlay rescales with zoom without moving the enclosed frames', () => {
    const rect = { frameStart: 24, frameEnd: 48, rowStart: 0, rowEnd: 1 };
    const zoomed = marqueeOverlayBox(rect, { ...v, pxPerSec: 96 });
    expect(zoomed.left).toBe(20 + 96); // frame 24 = 1s at 96px/s
    expect(zoomed.width).toBe(96);
  });
});
