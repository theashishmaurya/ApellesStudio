import { describe, expect, it } from 'vitest';

import { createShowQueue, cssColorToRgba, pictureRect, placementFromRects, sameRect } from './nativePreview';

describe('nativePreview geometry (D-451, D-454)', () => {
  const view = { x: 10, y: 40, width: 800, height: 450 };

  it('places the picture at its own box, which carries the zoom and pan', () => {
    const picture = { x: -90, y: 0, width: 1600, height: 900 };
    const p = placementFromRects(view, picture, [0, 0, 0, 1], true);
    expect(p.picture).toEqual(picture);
    expect(p.view).toEqual(view);
    expect(p.visible).toBe(true);
  });

  it('falls back to the whole view before the picture has a box', () => {
    expect(placementFromRects(view, null, [0, 0, 0, 1], true).picture).toEqual(view);
    expect(placementFromRects(view, { x: 0, y: 0, width: 0, height: 0 }, [0, 0, 0, 1], true).picture).toEqual(view);
  });

  it('hides a surface with no area', () => {
    expect(placementFromRects({ ...view, width: 0 }, null, [0, 0, 0, 1], true).visible).toBe(false);
    expect(placementFromRects(view, null, [0, 0, 0, 1], false).visible).toBe(false);
  });

  it('compares rectangles by value', () => {
    expect(sameRect(view, { ...view })).toBe(true);
    expect(sameRect(view, { ...view, x: 11 })).toBe(false);
    expect(sameRect(null, null)).toBe(true);
    expect(sameRect(view, null)).toBe(false);
  });

  it('reads the pane colour, and treats a transparent one as black', () => {
    expect(cssColorToRgba('rgb(0, 0, 0)')).toEqual([0, 0, 0, 1]);
    expect(cssColorToRgba('rgb(255, 51, 0)')).toEqual([1, 0.2, 0, 1]);
    expect(cssColorToRgba('rgba(0, 0, 0, 0)')).toEqual([0, 0, 0, 1]);
    expect(cssColorToRgba('transparent')).toEqual([0, 0, 0, 1]);
  });

  it('puts the picture box (the content box) where the surface is', () => {
    expect(pictureRect(view, { offsetX: 100, offsetY: 0, width: 600, height: 450 })).toEqual({
      x: 110,
      y: 40,
      width: 600,
      height: 450,
    });
    expect(pictureRect(view, { offsetX: 0, offsetY: 0, width: 0, height: 0 })).toBeNull();
  });
});

/** A show function whose answers the test releases one at a time. */
function heldShows() {
  const asked: number[] = [];
  const pending: (() => void)[] = [];
  return {
    asked,
    show: (position: number) => {
      asked.push(position);
      return new Promise<void>((resolve) => pending.push(resolve));
    },
    async answer(): Promise<void> {
      pending.shift()?.();
      // Let the queue's `.then` / `.finally` run.
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    },
  };
}

describe('the show queue (D-454): latest-wins, one in flight', () => {
  it('asks nothing until the surface is placed, then the newest position', () => {
    const h = heldShows();
    const q = createShowQueue({ show: h.show, onShown: () => {}, onError: () => {} });
    q.want(1);
    q.want(2);
    expect(h.asked).toEqual([]);
    q.ready();
    expect(h.asked).toEqual([2]);
  });

  it('drops the positions asked for while one is out, keeping only the newest', async () => {
    const h = heldShows();
    const shown: number[] = [];
    const q = createShowQueue({ show: h.show, onShown: (p) => shown.push(p), onError: () => {} });
    q.ready();
    q.want(10);
    q.want(11);
    q.want(12);
    q.want(13);
    expect(h.asked).toEqual([10]);
    await h.answer();
    expect(h.asked).toEqual([10, 13]);
    await h.answer();
    expect(shown).toEqual([10, 13]);
    expect(q.shown()).toBe(13);
  });

  it('does not ask again for the frame on screen, unless it was invalidated', async () => {
    const h = heldShows();
    const q = createShowQueue({ show: h.show, onShown: () => {}, onError: () => {} });
    q.ready();
    q.want(5);
    await h.answer();
    q.want(5);
    expect(h.asked).toEqual([5]);
    q.want(5, true);
    expect(h.asked).toEqual([5, 5]);
  });

  it('knows a frame playback showed, so pausing on it asks for nothing', () => {
    const h = heldShows();
    const q = createShowQueue({ show: h.show, onShown: () => {}, onError: () => {} });
    q.ready();
    q.markShown(42);
    q.want(42);
    expect(h.asked).toEqual([]);
  });

  it('reports a failed show and keeps going', async () => {
    const errors: string[] = [];
    let n = 0;
    const q = createShowQueue({
      show: () => (n++ === 0 ? Promise.reject(new Error('decode failed')) : Promise.resolve()),
      onShown: () => {},
      onError: (e) => errors.push(e),
    });
    q.ready();
    q.want(1);
    q.want(2);
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    expect(errors).toEqual(['Error: decode failed']);
    expect(q.shown()).toBe(2);
  });
});
