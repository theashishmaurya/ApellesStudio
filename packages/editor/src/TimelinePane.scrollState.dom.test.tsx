// @vitest-environment jsdom
/**
 * B-357 — the pane's scroll state follows the scroller, and a wheel over the
 * ruler or a lane overlay pans it.
 *
 * Found by the first live perf-300 run on the lanes (D-437): (1) a scroll state
 * left by one timeline survived into the next, because the pane renders nothing
 * between two timelines (the scroller unmounts) and a fresh scroller fires no
 * `scroll` event; (2) the wheel scenario aimed at a point that fell on a lane's
 * height-resize zone, a sibling of the scroller, which swallowed the wheel.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

import {
  actSync,
  createInvokeStub,
  installPointerCaptureStub,
  installResizeObserverStub,
  mount,
  stubOffsetMetrics,
  waitFrames,
  type MountedComponent,
} from './testUtils/pointerHarness';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: createInvokeStub({
    chroma_clip_thumbnails: () => [],
    chroma_audio_waveform: () => [],
    chroma_timeline_set: () => undefined,
  }),
}));

import { useEditorTimelineStore } from './timelineStore';
import { TimelinePane } from './TimelinePane';
import { TIMELINE_TEST_IDS, TIMELINE_VIEW_ATTRS } from './timelineTestIds';
import type { Timeline } from './timeline';

const timeline: Timeline = {
  id: 'scroll-tl',
  name: 'scroll',
  rate: { num: 24, den: 1 },
  tracks: [{ kind: 'video', clips: [{ id: 'v', name: 'V', source_path: '/v.mp4', source_start: 0, duration: 2400, source_len: 2400, start_frame: 0 }] }],
};

let restores: Array<() => void> = [];
let ui: MountedComponent | null = null;

const open = () =>
  actSync(() => useEditorTimelineStore.setState({ timeline, openProjectKey: '/p/scroll.chroma', status: 'ready', error: null, playhead: 0, selection: [] }));
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const viewScrollLeft = () => Number(q(TIMELINE_TEST_IDS.editArea)!.getAttribute(TIMELINE_VIEW_ATTRS.scrollLeft));

beforeEach(async () => {
  restores = [stubOffsetMetrics(1200, 600), installResizeObserverStub(), installPointerCaptureStub()];
  open();
  ui = mount(React.createElement(TimelinePane), { strictMode: true });
  await waitFrames(2);
});

afterEach(() => {
  ui?.unmount();
  ui = null;
  for (const r of restores) r();
  actSync(() => useEditorTimelineStore.setState({ timeline: null, openProjectKey: null, status: 'idle' }));
});

describe('the scroll state follows the scroller (B-357)', () => {
  it('a scroller that mounts at 0 resets the pane state a previous timeline left behind', async () => {
    const scroller = q(TIMELINE_TEST_IDS.scroller)!;
    scroller.scrollLeft = 364;
    actSync(() => void scroller.dispatchEvent(new Event('scroll', { bubbles: true })));
    expect(viewScrollLeft()).toBe(364);

    // No timeline open: the pane renders nothing, the scroller is gone.
    actSync(() => useEditorTimelineStore.setState({ timeline: null }));
    await waitFrames(1);
    expect(q(TIMELINE_TEST_IDS.scroller)).toBeNull();

    // The next timeline: a new scroller, at 0, which fires no scroll event.
    open();
    await waitFrames(2);
    expect(q(TIMELINE_TEST_IDS.scroller)!.scrollLeft).toBe(0);
    expect(viewScrollLeft()).toBe(0);
  });
});

describe('a wheel over the ruler pans the lanes (B-357)', () => {
  it('forwards a plain wheel from outside the scroller to it, and leaves one inside alone', () => {
    const scroller = q(TIMELINE_TEST_IDS.scroller)!;
    const scrollBy = vi.fn();
    scroller.scrollBy = scrollBy as unknown as typeof scroller.scrollBy;

    const ruler = q(TIMELINE_TEST_IDS.ruler)!;
    const outside = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: 120, deltaY: 30 });
    ruler.dispatchEvent(outside);
    expect(scrollBy).toHaveBeenCalledWith({ left: 120, top: 30 });
    expect(outside.defaultPrevented).toBe(true);

    scrollBy.mockClear();
    const inside = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: 120 });
    scroller.dispatchEvent(inside);
    expect(scrollBy).not.toHaveBeenCalled();
    expect(inside.defaultPrevented).toBe(false);
  });
});
