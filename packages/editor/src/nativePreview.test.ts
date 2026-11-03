import { describe, expect, it } from 'vitest';

import { cssColorToRgba, placementFromRects, sameRect } from './nativePreview';

describe('nativePreview geometry (D-451)', () => {
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
});
