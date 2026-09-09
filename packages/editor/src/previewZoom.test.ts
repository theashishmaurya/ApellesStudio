/**
 * @apelles/editor — unit coverage for the preview viewport's zoom/pan math
 * (D-218, `previewZoom.ts`).
 *
 * This is the tier where an off-by-one in the zoom would actually hide, the
 * same split `transformGeometry.test.ts` covers for the clip-transform math:
 * pure functions, no DOM, this package's `node` vitest environment. The
 * component wiring (the wheel gesture, the `<img>` transform, and — the part
 * that matters most — that click-to-select and a transform drag stay correct
 * at a non-fit zoom) is covered at the real-DOM tier in
 * `PreviewPane.zoom.dom.test.tsx`.
 */
import { describe, expect, it } from 'vitest';

import {
  clampPreviewView,
  clampPreviewZoom,
  fitPointAt,
  FIT_VIEW,
  isFitView,
  MAX_PREVIEW_ZOOM,
  MIN_PREVIEW_ZOOM,
  pannedByPixels,
  panLimit,
  previewZoomPct,
  PREVIEW_ZOOM_STEP,
  steppedZoom,
  zoomAbout,
  zoomedContentBox,
} from './previewZoom';
import { screenToFraction, boxToScreenRect } from './transformGeometry';

/** A 1000×500 fit box with no letterboxing — the same geometry the DOM suites
 *  stub, so a number here and a number there mean the same thing. */
const FIT = { offsetX: 0, offsetY: 0, width: 1000, height: 500 };
/** A letterboxed fit box: a 2:1 picture inside a 1000×600 container. */
const LETTERBOXED = { offsetX: 0, offsetY: 50, width: 1000, height: 500 };

describe('clamping', () => {
  it('holds zoom inside the preview-scoped bounds', () => {
    expect(clampPreviewZoom(0.01)).toBe(MIN_PREVIEW_ZOOM);
    expect(clampPreviewZoom(1000)).toBe(MAX_PREVIEW_ZOOM);
    expect(clampPreviewZoom(2)).toBe(2);
  });

  it('resolves a non-finite zoom to FIT rather than propagating or pinning', () => {
    // "we could not read that" is not "zoom all the way in" — see
    // `clampPreviewZoom`'s own doc.
    expect(clampPreviewZoom(Number.NaN)).toBe(1);
    expect(clampPreviewZoom(Number.POSITIVE_INFINITY)).toBe(1);
    expect(clampPreviewView({ zoom: 2, panX: Number.NaN, panY: 0 })).toEqual({ zoom: 2, panX: 0, panY: 0 });
  });

  it('allows no pan at all at fit, or zoomed out', () => {
    expect(panLimit(1)).toBe(0);
    expect(panLimit(0.5)).toBe(0);
    expect(clampPreviewView({ zoom: 1, panX: 0.4, panY: -0.9 })).toEqual(FIT_VIEW);
  });

  it('lets the picture pan exactly until its own edge reaches the fit box edge', () => {
    // At 2×, the picture is twice the fit box, so half a fit-box width of it
    // hangs off each side: the legal pan is ±0.5.
    expect(panLimit(2)).toBeCloseTo(0.5, 12);
    expect(clampPreviewView({ zoom: 2, panX: 0.9, panY: -0.9 })).toEqual({ zoom: 2, panX: 0.5, panY: -0.5 });

    // ...and that limit really is "edge meets edge", checked through the box.
    const box = zoomedContentBox(FIT, { zoom: 2, panX: panLimit(2), panY: 0 });
    expect(box.offsetX).toBeCloseTo(FIT.offsetX, 9);
    const other = zoomedContentBox(FIT, { zoom: 2, panX: -panLimit(2), panY: 0 });
    expect(other.offsetX + other.width).toBeCloseTo(FIT.offsetX + FIT.width, 9);
  });
});

describe('zoomedContentBox', () => {
  it('is the fit box itself at the fit view', () => {
    expect(zoomedContentBox(FIT, FIT_VIEW)).toEqual(FIT);
    expect(zoomedContentBox(LETTERBOXED, FIT_VIEW)).toEqual(LETTERBOXED);
  });

  it('scales about the fit box centre, so the centre stays put', () => {
    const box = zoomedContentBox(FIT, { zoom: 2, panX: 0, panY: 0 });
    expect(box.width).toBe(2000);
    expect(box.height).toBe(1000);
    expect(box.offsetX + box.width / 2).toBeCloseTo(FIT.offsetX + FIT.width / 2, 9);
    expect(box.offsetY + box.height / 2).toBeCloseTo(FIT.offsetY + FIT.height / 2, 9);
  });

  it('respects the container letterbox offset it was measured with', () => {
    const box = zoomedContentBox(LETTERBOXED, { zoom: 2, panX: 0, panY: 0 });
    expect(box.offsetY + box.height / 2).toBeCloseTo(LETTERBOXED.offsetY + LETTERBOXED.height / 2, 9);
  });

  it('displaces by pan measured in fit-box widths, not pixels', () => {
    const box = zoomedContentBox(FIT, { zoom: 2, panX: 0.25, panY: -0.1 });
    expect(box.offsetX).toBeCloseTo(-500 + 0.25 * 1000, 9);
    expect(box.offsetY).toBeCloseTo(-250 + -0.1 * 500, 9);
  });
});

describe('the coordinate contract every overlay depends on (docs/notes/on-canvas-transform.md)', () => {
  // The whole point of the design: composition fractions keep meaning exactly
  // what they meant, and the zoomed box is still a content box. These two are
  // the round trips `TransformOverlay` and `useCanvasClipPick` actually make.
  it('round-trips a composition fraction through the ZOOMED box unchanged', () => {
    for (const view of [FIT_VIEW, { zoom: 2, panX: 0.3, panY: -0.2 }, { zoom: 0.5, panX: 0, panY: 0 }]) {
      const box = zoomedContentBox(LETTERBOXED, view);
      const rect = boxToScreenRect({ left: 0.25, top: 0.4, width: 0.5, height: 0.2 }, box);
      const back = screenToFraction({ x: rect.left, y: rect.top }, box);
      expect(back.x).toBeCloseTo(0.25, 9);
      expect(back.y).toBeCloseTo(0.4, 9);
    }
  });

  it('makes the same screen-pixel drag a SMALLER fraction delta the further you zoom in', () => {
    // This is the behaviour the DOM suite proves end to end: at 2× the
    // picture is twice as big, so 100px of pointer travel is half as much of
    // the composition. A zoom that failed to do this would silently make
    // every on-canvas drag wrong by exactly the zoom factor.
    const at1 = screenToFraction({ x: 100, y: 0 }, zoomedContentBox(FIT, FIT_VIEW));
    const at2 = screenToFraction({ x: 100, y: 0 }, zoomedContentBox(FIT, { zoom: 2, panX: 0, panY: 0 }));
    const origin1 = screenToFraction({ x: 0, y: 0 }, zoomedContentBox(FIT, FIT_VIEW));
    const origin2 = screenToFraction({ x: 0, y: 0 }, zoomedContentBox(FIT, { zoom: 2, panX: 0, panY: 0 }));
    expect(at1.x - origin1.x).toBeCloseTo(0.1, 9);
    expect(at2.x - origin2.x).toBeCloseTo(0.05, 9);
  });
});

describe('zoomAbout', () => {
  it('keeps the picture point under the anchor under the anchor', () => {
    const anchor = fitPointAt({ x: 900, y: 100 }, FIT); // near the top-right
    const before = zoomedContentBox(FIT, FIT_VIEW);
    const pointBefore = screenToFraction({ x: 900, y: 100 }, before);

    const view = zoomAbout(FIT_VIEW, anchor, 2);
    const after = zoomedContentBox(FIT, view);
    const pointAfter = screenToFraction({ x: 900, y: 100 }, after);

    expect(pointAfter.x).toBeCloseTo(pointBefore.x, 9);
    expect(pointAfter.y).toBeCloseTo(pointBefore.y, 9);
  });

  it('zooms about the fit centre for a centre anchor, leaving the pan alone', () => {
    expect(zoomAbout(FIT_VIEW, { x: 0, y: 0 }, 4)).toEqual({ zoom: 4, panX: 0, panY: 0 });
  });

  it('walks an existing pan back to centre as the zoom returns to fit', () => {
    const zoomedIn = zoomAbout(FIT_VIEW, fitPointAt({ x: 1000, y: 500 }, FIT), 4);
    expect(zoomedIn.panX).not.toBe(0);
    const backToFit = zoomAbout(zoomedIn, { x: 0, y: 0 }, 1);
    expect(backToFit).toEqual(FIT_VIEW);
  });

  it('clamps the pan its own anchoring would otherwise produce', () => {
    // Anchoring hard against a corner at a small zoom wants more pan than
    // that zoom allows; the picture must not be able to leave the fit box.
    const view = zoomAbout(FIT_VIEW, fitPointAt({ x: 1000, y: 500 }, FIT), 1.1);
    expect(Math.abs(view.panX)).toBeLessThanOrEqual(panLimit(1.1) + 1e-12);
    expect(Math.abs(view.panY)).toBeLessThanOrEqual(panLimit(1.1) + 1e-12);
  });
});

describe('steppedZoom', () => {
  it('steps by the same factor the timeline zoom uses', () => {
    expect(steppedZoom(FIT_VIEW, { x: 0, y: 0 }, 'in').zoom).toBeCloseTo(PREVIEW_ZOOM_STEP, 12);
    expect(steppedZoom(FIT_VIEW, { x: 0, y: 0 }, 'out').zoom).toBeCloseTo(1 / PREVIEW_ZOOM_STEP, 12);
  });

  it('is reversible, and stops at the bounds', () => {
    const inThenOut = steppedZoom(steppedZoom(FIT_VIEW, { x: 0, y: 0 }, 'in'), { x: 0, y: 0 }, 'out');
    expect(inThenOut.zoom).toBeCloseTo(1, 12);

    let view = FIT_VIEW;
    for (let i = 0; i < 100; i++) view = steppedZoom(view, { x: 0, y: 0 }, 'in');
    expect(view.zoom).toBe(MAX_PREVIEW_ZOOM);
    for (let i = 0; i < 200; i++) view = steppedZoom(view, { x: 0, y: 0 }, 'out');
    expect(view.zoom).toBe(MIN_PREVIEW_ZOOM);
  });
});

describe('pannedByPixels', () => {
  it('does nothing at fit — a plain scroll must not drift the preview', () => {
    expect(pannedByPixels(FIT_VIEW, FIT, 120, -80)).toEqual(FIT_VIEW);
  });

  it('converts a screen delta into fit-box fractions, content-follows-scroll', () => {
    const view = pannedByPixels({ zoom: 4, panX: 0, panY: 0 }, FIT, 100, 50);
    expect(view.panX).toBeCloseTo(-0.1, 9);
    expect(view.panY).toBeCloseTo(-0.1, 9);
  });

  it('clamps at the edge rather than letting the picture run away', () => {
    const view = pannedByPixels({ zoom: 2, panX: 0, panY: 0 }, FIT, -100000, 0);
    expect(view.panX).toBeCloseTo(panLimit(2), 12);
  });

  it('survives a zero-size fit box (nothing measured yet)', () => {
    const empty = { offsetX: 0, offsetY: 0, width: 0, height: 0 };
    expect(() => pannedByPixels({ zoom: 2, panX: 0, panY: 0 }, empty, 10, 10)).not.toThrow();
  });
});

describe('readouts', () => {
  it('reports a whole percentage, the same shape TimelinePane does', () => {
    expect(previewZoomPct(1)).toBe(100);
    expect(previewZoomPct(2)).toBe(200);
    expect(previewZoomPct(1 / PREVIEW_ZOOM_STEP)).toBe(83);
  });

  it('recognises exactly the default view as fit', () => {
    expect(isFitView(FIT_VIEW)).toBe(true);
    expect(isFitView({ zoom: 1, panX: 0.01, panY: 0 })).toBe(false);
    expect(isFitView({ zoom: 1.2, panX: 0, panY: 0 })).toBe(false);
  });
});
