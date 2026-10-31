// @vitest-environment jsdom
/**
 * D-437 S3b — `Playhead`: transform-only positioning with no React render per
 * frame, pointer-transparent line with only the head and band grabbable, the
 * scrub callback order with snapping, every way a scrub ends, edge autoscroll.
 *
 * jsdom has no layout, so the root's rect and the scroller's rect/scrollLeft
 * are stubbed. Fixture: 24 fps, 100 px/s, `startLeftPx` 32 → frame f is at
 * x = 32 + f / 24 × 100 (frame 48 → 232).
 */
import React, { createRef, Profiler } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  actSync,
  firePointerEvent,
  installPointerCaptureStub,
  mount,
  nextFrame,
  type MountedComponent,
} from '../testUtils/pointerHarness';
import { Playhead, playheadX, type PlayheadHandle, type PlayheadProps } from './Playhead';
import { TIMELINE_TEST_IDS as ID } from '../timelineTestIds';

const FPS = 24;
const PX = 100;
const START = 32;
const RULER = 24;
const BAND = 12;

let restoreCapture: () => void;
let mounted: MountedComponent | null = null;
beforeEach(() => {
  restoreCapture = installPointerCaptureStub();
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  restoreCapture();
});

function q(testId: string): HTMLElement {
  const el = document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!el) throw new Error(`missing ${testId}`);
  return el;
}

/** x from the line's inline transform. */
function lineX(): number {
  const m = /translate3d\((-?[\d.]+)px/.exec(q(ID.playhead).style.transform);
  if (!m) throw new Error(`no translate3d in "${q(ID.playhead).style.transform}"`);
  return Number(m[1]);
}

interface Setup {
  handle: React.RefObject<PlayheadHandle | null>;
  calls: string[];
  commits: { n: number };
  scroller: HTMLElement;
  parentPointerDown: ReturnType<typeof vi.fn>;
}

function setup(overrides: Partial<PlayheadProps> = {}, snap: (f: number) => number = (f) => f): Setup {
  const handle = createRef<PlayheadHandle>();
  const calls: string[] = [];
  const commits = { n: 0 };
  const scroller = document.createElement('div');
  scroller.getBoundingClientRect = () => ({ left: 0, right: 1000, top: 0, bottom: 300, width: 1000, height: 300, x: 0, y: 0, toJSON() {} });
  const parentPointerDown = vi.fn();
  mounted = mount(
    <div onPointerDown={parentPointerDown}>
      <Profiler id="playhead" onRender={() => (commits.n += 1)}>
        <Playhead
          ref={handle}
          fps={FPS}
          pxPerSec={PX}
          startLeftPx={START}
          rulerHeightPx={RULER}
          bandHeightPx={BAND}
          durationFrames={240}
          getScroller={() => scroller}
          snapFrame={snap}
          onScrubStart={(f) => calls.push(`start:${f}`)}
          onScrub={(f) => calls.push(`scrub:${f}`)}
          onScrubEnd={() => calls.push('end')}
          {...overrides}
        />
      </Profiler>
    </div>,
  );
  // jsdom rects are all zeros: the root sits at the edit area's left edge.
  q(ID.playhead).parentElement!.getBoundingClientRect = () =>
    ({ left: 0, right: 1000, top: 0, bottom: 300, width: 1000, height: 300, x: 0, y: 0, toJSON() {} }) as DOMRect;
  return { handle, calls, commits, scroller, parentPointerDown };
}

describe('Playhead positioning', () => {
  it('puts the line at frame 0 on mount, by transform only, on its own layer', () => {
    setup();
    expect(lineX()).toBe(START);
    expect(q(ID.playhead).style.willChange).toBe('transform');
    expect(q(ID.playhead).style.left).toBe('');
  });

  it('setFrame and setScroll write transform and no React render', () => {
    const s = setup();
    const before = s.commits.n;
    actSync(() => s.handle.current!.setFrame(48));
    expect(lineX()).toBe(START + 2 * PX);
    actSync(() => s.handle.current!.setScroll(100));
    expect(lineX()).toBe(START + 2 * PX - 100);
    for (let f = 0; f < 200; f++) actSync(() => s.handle.current!.setFrame(f));
    expect(s.commits.n).toBe(before);
    expect(q(ID.playhead).style.left).toBe('');
  });

  it('re-places the line in the commit of a zoom', () => {
    const s = setup();
    actSync(() => s.handle.current!.setFrame(48));
    mounted!.unmount();
    mounted = null;
    setup({ pxPerSec: 200 });
    expect(lineX()).toBe(START);
    expect(playheadX(48, 0, FPS, 200, START, 1)).toBe(START + 400);
  });

  it('rounds to the device pixel', () => {
    expect(playheadX(1, 0, FPS, PX, START, 1)).toBe(36);
    expect(playheadX(1, 0, FPS, PX, START, 2)).toBe(36);
    expect(playheadX(1, 0, FPS, 110, START, 2)).toBe(36.5);
    expect(playheadX(1, 0, FPS, 110, START, 1)).toBe(37);
    expect(playheadX(1, 0, FPS, PX, START, 0)).toBe(36);
  });

  it('exposes slider semantics, kept current imperatively', () => {
    const s = setup();
    const head = q(ID.playheadHead);
    expect(head.getAttribute('role')).toBe('slider');
    expect(head.getAttribute('aria-label')).toBe('Playhead');
    expect(head.getAttribute('aria-valuemin')).toBe('0');
    expect(head.getAttribute('aria-valuemax')).toBe('240');
    expect(head.hasAttribute('tabindex')).toBe(false);
    actSync(() => s.handle.current!.setFrame(60));
    expect(head.getAttribute('aria-valuenow')).toBe('60');
    expect(head.getAttribute('aria-valuetext')).toBe('00:02:12');
  });
});

describe('Playhead hit testing', () => {
  it('the line and root are pointer-transparent; only the head and band take the pointer', () => {
    setup();
    expect(q(ID.playhead).style.pointerEvents).toBe('none');
    expect(q(ID.playhead).parentElement!.style.pointerEvents).toBe('none');
    expect(q(ID.playheadHead).style.pointerEvents).toBe('auto');
    expect(q(ID.playheadBand).style.pointerEvents).toBe('auto');
  });

  it('keeps the data-chroma-* hooks the marquee guard and harness read', () => {
    setup();
    for (const id of [ID.playhead, ID.playheadHead, ID.playheadBand]) {
      expect(q(id).hasAttribute('data-chroma-playhead')).toBe(true);
    }
    expect(q(ID.playheadHead).hasAttribute('data-chroma-no-marquee')).toBe(true);
    expect(q(ID.playheadBand).hasAttribute('data-chroma-no-marquee')).toBe(true);
  });

  it('sizes the head over the ruler and the band under it', () => {
    setup();
    expect(q(ID.playheadHead).style.top).toBe(`${-RULER}px`);
    expect(q(ID.playheadHead).style.height).toBe(`${RULER}px`);
    expect(q(ID.playheadBand).style.height).toBe(`${BAND}px`);
    expect(q(ID.playhead).style.top).toBe(`${RULER}px`);
  });
});

describe('Playhead scrub', () => {
  it('calls start, scrub (snapped, only on change), end in order', () => {
    const s = setup({}, (f) => Math.round(f / 10) * 10);
    const band = q(ID.playheadBand);
    firePointerEvent(band, 'pointerdown', { x: 232, y: 40 }); // frame 48 -> 50
    firePointerEvent(band, 'pointermove', { x: 233, y: 40 }); // still frame 50
    firePointerEvent(band, 'pointermove', { x: 332, y: 40 }); // frame 72 -> 70
    firePointerEvent(band, 'pointermove', { x: 332, y: 60 }); // unchanged
    firePointerEvent(band, 'pointerup', { x: 332, y: 40 });
    expect(s.calls).toEqual(['start:50', 'scrub:70', 'end']);
  });

  it('works from the head too, and clamps to frame 0', () => {
    const s = setup();
    const head = q(ID.playheadHead);
    firePointerEvent(head, 'pointerdown', { x: 100, y: 10 });
    firePointerEvent(head, 'pointermove', { x: -500, y: 10 });
    firePointerEvent(head, 'pointerup', { x: -500, y: 10 });
    expect(s.calls).toEqual(['start:16', 'scrub:0', 'end']);
  });

  it('accounts for the scroll position', () => {
    const s = setup();
    s.scroller.scrollLeft = 100;
    firePointerEvent(q(ID.playheadBand), 'pointerdown', { x: 132, y: 40 }); // content x 232 -> 48
    firePointerEvent(q(ID.playheadBand), 'pointerup', { x: 132, y: 40 });
    expect(s.calls[0]).toBe('start:48');
  });

  it('does not let the press reach anything underneath, and ignores other buttons', () => {
    const s = setup();
    firePointerEvent(q(ID.playheadBand), 'pointerdown', { x: 232, y: 40 }, { button: 2 });
    expect(s.calls).toEqual([]);
    s.parentPointerDown.mockClear();
    firePointerEvent(q(ID.playheadBand), 'pointerdown', { x: 232, y: 40 });
    expect(s.parentPointerDown).not.toHaveBeenCalled();
    firePointerEvent(q(ID.playheadBand), 'pointerup', { x: 232, y: 40 });
  });

  it('ignores a second press while one scrub is active, and another pointer', () => {
    const s = setup();
    const band = q(ID.playheadBand);
    firePointerEvent(band, 'pointerdown', { x: 232, y: 40 });
    firePointerEvent(q(ID.playheadHead), 'pointerdown', { x: 300, y: 10 }, { pointerId: 2 });
    firePointerEvent(band, 'pointermove', { x: 400, y: 40 }, { pointerId: 2 });
    firePointerEvent(band, 'pointerup', { x: 400, y: 40 }, { pointerId: 2 });
    expect(s.calls).toEqual(['start:48']);
    firePointerEvent(band, 'pointerup', { x: 232, y: 40 });
    expect(s.calls).toEqual(['start:48', 'end']);
  });

  it('ends the scrub on pointercancel', () => {
    const s = setup();
    firePointerEvent(q(ID.playheadBand), 'pointerdown', { x: 232, y: 40 });
    firePointerEvent(q(ID.playheadBand), 'pointercancel', { x: 232, y: 40 });
    expect(s.calls).toEqual(['start:48', 'end']);
  });

  it('ends the scrub when pointer capture is lost, once', () => {
    const s = setup();
    const band = q(ID.playheadBand);
    firePointerEvent(band, 'pointerdown', { x: 232, y: 40 });
    actSync(() => {
      band.dispatchEvent(new PointerEvent('lostpointercapture', { bubbles: true, pointerId: 1 }));
    });
    firePointerEvent(band, 'pointerup', { x: 232, y: 40 });
    expect(s.calls).toEqual(['start:48', 'end']);
  });

  it('ends the scrub when the component unmounts mid-drag, once', () => {
    const s = setup();
    firePointerEvent(q(ID.playheadBand), 'pointerdown', { x: 232, y: 40 });
    mounted!.unmount();
    mounted = null;
    expect(s.calls).toEqual(['start:48', 'end']);
  });

  it('does not end anything on unmount when no scrub is active', () => {
    const s = setup();
    mounted!.unmount();
    mounted = null;
    expect(s.calls).toEqual([]);
  });

});

describe('Playhead edge autoscroll', () => {
  it('scrolls the scroller while the pointer is held in an edge zone, and reports the new frames', async () => {
    const s = setup();
    const band = q(ID.playheadBand);
    firePointerEvent(band, 'pointerdown', { x: 500, y: 40 });
    firePointerEvent(band, 'pointermove', { x: 995, y: 40 });
    await nextFrame();
    await nextFrame();
    expect(s.scroller.scrollLeft).toBeGreaterThan(0);
    const scrubs = s.calls.filter((c) => c.startsWith('scrub:')).map((c) => Number(c.slice(6)));
    expect(scrubs.length).toBeGreaterThan(1);
    expect(scrubs[scrubs.length - 1]).toBeGreaterThan(scrubs[0]);
    firePointerEvent(band, 'pointerup', { x: 995, y: 40 });
    const stopped = s.scroller.scrollLeft;
    await nextFrame();
    await nextFrame();
    expect(s.scroller.scrollLeft).toBe(stopped);
  });

  it('scrolls left near the left edge and not at all in the middle', async () => {
    const s = setup();
    s.scroller.scrollLeft = 1000;
    const band = q(ID.playheadBand);
    firePointerEvent(band, 'pointerdown', { x: 500, y: 40 });
    firePointerEvent(band, 'pointermove', { x: 600, y: 40 });
    await nextFrame();
    await nextFrame();
    expect(s.scroller.scrollLeft).toBe(1000);
    firePointerEvent(band, 'pointermove', { x: 3, y: 40 });
    await nextFrame();
    await nextFrame();
    expect(s.scroller.scrollLeft).toBeLessThan(1000);
    firePointerEvent(band, 'pointerup', { x: 3, y: 40 });
  });
});
