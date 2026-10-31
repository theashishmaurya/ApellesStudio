// @vitest-environment jsdom
/**
 * @apelles/editor — a scroll renders the pane ZERO times (D-437 S8; plan
 * `docs/notes/timeline-lanes.md` §2.3, §4 "Scroll").
 *
 * What is counted, and how:
 *   - **Pane renders**: `useViewportWidth` is called by `TimelinePane` and
 *     nothing else, once per render, so a counting wrapper around it IS the
 *     pane's render count. The React Compiler memoises unchanged children, so a
 *     child-side counter could not tell.
 *   - **Lane renders**: `laneWindow` is called by `TimelineLanes` and nothing
 *     else, once per render: its call count is the lanes' render count.
 *   - **Clip renders**: `LaneClip`'s `memo` boundary (the `react` mock, as in
 *     `TimelinePane.laneRenders.dom.test.tsx`).
 * Mounted without StrictMode, which doubles every render in dev.
 *
 * jsdom has no layout: the viewport is 1200 px (`stubOffsetMetrics`), so the
 * lanes cull with a 600 px bucket, and a scroll is `scrollLeft`/`scrollTop`
 * writes plus the `scroll` event the browser would fire.
 */
import type { FunctionComponent } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const counts = vi.hoisted(() => ({ pane: 0, lanes: 0, clips: 0 }));
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  type Props = { clip?: { id: string }; leftPx?: number; actions?: unknown };
  return {
    ...actual,
    memo: ((component: FunctionComponent<Props>, compare?: undefined) =>
      actual.memo(function Counted(props: Props) {
        if (props.clip && props.leftPx !== undefined && props.actions !== undefined) counts.clips++;
        return component(props);
      }, compare)) as typeof actual.memo,
  };
});
vi.mock('./useViewportWidth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./useViewportWidth')>();
  return {
    ...actual,
    useViewportWidth: (...args: Parameters<typeof actual.useViewportWidth>) => {
      counts.pane++;
      return actual.useViewportWidth(...args);
    },
  };
});
vi.mock('./lanes/laneWindow', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lanes/laneWindow')>();
  return {
    ...actual,
    laneWindow: (...args: Parameters<typeof actual.laneWindow>) => {
      counts.lanes++;
      return actual.laneWindow(...args);
    },
  };
});

import React from 'react';
import {
  actSync,
  captureConsole,
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
import { useTimelineViewStore } from './timelineView';
import { TimelinePane } from './TimelinePane';
import { TIMELINE_TEST_IDS as ID, TIMELINE_VIEW_ATTRS } from './timelineTestIds';
import type { Clip, Timeline } from './timeline';
import { laneWindowParams } from './lanes/laneWindow';

const FPS = 24;
const VIEWPORT = 1200;
const CLIPS = 200;
/** 1 s clips back to back on V1 (`v0..`) and A1 (`a0..`), a transition on the
 *  V1 cut at 2 s, and a marker at 10 s. 200 s at the default 90 px/s = 18000 px. */
function fixture(): Timeline {
  const clip = (id: string, i: number): Clip =>
    ({ id, name: id, source_path: `/${id}.mp4`, source_start: 24, duration: 24, source_len: 240, start_frame: i * 24 }) as Clip;
  return {
    id: 'scroll-renders',
    name: 'scroll renders',
    rate: { num: FPS, den: 1 },
    tracks: [
      {
        kind: 'video',
        clips: Array.from({ length: CLIPS }, (_, i) => clip(`v${i}`, i)),
        transitions: [{ id: 't1', at_frame: 48, duration: 12, kind: 'dissolve' }],
      },
      { kind: 'audio', clips: Array.from({ length: CLIPS }, (_, i) => clip(`a${i}`, i)) },
    ],
    markers: [{ id: 'm1', frame: 240 }],
  } as unknown as Timeline;
}

let restores: Array<() => void> = [];
let mounted: MountedComponent | null = null;
let console_: ReturnType<typeof captureConsole>;

const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const scroller = () => q(ID.scroller)!;
const area = () => q(ID.editArea)!;
const resetCounts = () => {
  counts.pane = 0;
  counts.lanes = 0;
  counts.clips = 0;
};
/** One scroll frame, as the browser delivers it. */
function scrollTo(left: number, top = scroller().scrollTop) {
  actSync(() => {
    scroller().scrollLeft = left;
    scroller().scrollTop = top;
    scroller().dispatchEvent(new Event('scroll'));
  });
}

beforeEach(async () => {
  restores = [stubOffsetMetrics(VIEWPORT, 600), installResizeObserverStub(), installPointerCaptureStub()];
  console_ = captureConsole();
  useTimelineViewStore.setState(useTimelineViewStore.getInitialState());
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline: fixture(),
      openProjectKey: '/projects/scroll-renders.chroma',
      status: 'ready',
      error: null,
      playhead: 0,
      playing: false,
      selection: [],
      selectedGap: null,
    }),
  );
  mounted = mount(React.createElement(TimelinePane), { strictMode: false });
  await waitFrames(2);
  resetCounts();
});

afterEach(() => {
  console_.restore();
  mounted?.unmount();
  mounted = null;
  restores.forEach((r) => r());
  actSync(() =>
    useEditorTimelineStore.setState({ timeline: null, openProjectKey: null, status: 'idle', playing: false, selection: [] }),
  );
});

describe('D-437 S8 — a horizontal scroll renders the pane zero times', () => {
  it('3000 px in 60 frames: 0 pane renders, lane renders only on window-bucket crossings', () => {
    const { bucketPx } = laneWindowParams(VIEWPORT);
    expect(bucketPx).toBe(600);
    for (let i = 1; i <= 60; i++) scrollTo(i * 50);
    expect(counts.pane).toBe(0);
    // 0 → 3000 px crosses the 600 px bucket at 600, 1200, 1800, 2400, 3000.
    expect(counts.lanes).toBe(3000 / bucketPx);
    // The clips that entered the window mounted; nothing re-rendered per frame.
    expect(counts.clips).toBeGreaterThan(0);
    expect(counts.clips).toBeLessThan(5 * 2 * 20);
  });

  it('a scroll inside one bucket renders neither the pane nor the lanes nor any clip', () => {
    for (const x of [10, 120, 340, 599]) scrollTo(x);
    expect(counts).toEqual({ pane: 0, lanes: 0, clips: 0 });
  });

  it('the view attributes, the playhead and the store follow the scroller', () => {
    scrollTo(1234);
    expect(area().getAttribute(TIMELINE_VIEW_ATTRS.scrollLeft)).toBe('1234');
    const startLeft = Number(area().getAttribute(TIMELINE_VIEW_ATTRS.startLeft));
    // The playhead (frame 0) sits at x = startLeft - scrollLeft in edit-area px.
    expect(q(ID.playhead)!.style.transform).toBe(`translate3d(${startLeft - 1234}px, 0, 0)`);
    expect(counts.pane).toBe(0);
  });

  it('the ruler and the marker flag re-render with the new scroll (pinned strips), the pane does not', () => {
    const marker = () => document.querySelector<HTMLElement>('[data-chroma-marker="m1"]')!;
    const startLeft = Number(area().getAttribute(TIMELINE_VIEW_ATTRS.startLeft));
    const pxPerSec = Number(area().getAttribute(TIMELINE_VIEW_ATTRS.pxPerSec));
    expect(marker().style.left).toBe(`${startLeft + 10 * pxPerSec}px`);
    scrollTo(500);
    expect(marker().style.left).toBe(`${startLeft + 10 * pxPerSec - 500}px`);
    const firstLabel = document.querySelector<HTMLElement>(`[data-testid="${ID.rulerLabel}"]`)!;
    expect(Number.parseFloat(firstLabel.style.left)).toBeLessThan(startLeft);
    expect(counts.pane).toBe(0);
  });

  it('content-space overlays live in the scroller and do not move or re-render on scroll', () => {
    const badge = q(ID.transition)!;
    expect(scroller().contains(badge)).toBe(true);
    const before = badge.style.left;
    const startLeft = Number(area().getAttribute(TIMELINE_VIEW_ATTRS.startLeft));
    const pxPerSec = Number(area().getAttribute(TIMELINE_VIEW_ATTRS.pxPerSec));
    // The transition window starts half its duration before the cut (frame 48 - 6).
    expect(before).toBe(`${startLeft + (42 / FPS) * pxPerSec}px`);
    scrollTo(400, 20);
    expect(badge.style.left).toBe(before);
    expect(q(ID.transition)).toBe(badge);
    // The drop zones and the height zones ride along too.
    const lane = document.querySelector<HTMLElement>(`[data-testid="${ID.trackLane}"][data-chroma-track="1"]`)!;
    expect(scroller().contains(lane)).toBe(true);
    const row1 = document.querySelectorAll<HTMLElement>(`[data-testid="${ID.trackRow}"]`)[1];
    expect(lane.style.top).toBe(row1.style.top); // content px: the row's own top, no scroll term
    expect(scroller().contains(q(ID.laneHeightResize))).toBe(true);
    expect(counts.pane).toBe(0);
  });
});

describe('D-437 S8 — a vertical scroll moves the header column without a render', () => {
  it('writes translateY on the header column and the scrollTop view attribute', () => {
    const header = q(ID.trackHeader)!.parentElement!.closest<HTMLElement>('.absolute')!;
    scrollTo(0, 37);
    expect(header.style.transform).toBe('translateY(-37px)');
    expect(area().getAttribute(TIMELINE_VIEW_ATTRS.scrollTop)).toBe('37');
    scrollTo(0, 0);
    expect(header.style.transform).toBe('');
    expect(counts.pane).toBe(0);
  });
});

describe('D-437 S8 — zoom and playback follow still write the scroller', () => {
  it('a pinch frame (3 ctrl-wheels) is ONE zoom step: one pane render, the anchored scroll in the same step', async () => {
    scrollTo(900);
    const before = useTimelineViewStore.getState().pxPerSec;
    resetCounts();
    for (let i = 0; i < 3; i++) {
      const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -4, clientX: 600, clientY: 100 });
      Object.defineProperty(e, 'ctrlKey', { value: true });
      actSync(() => void area().dispatchEvent(e));
    }
    expect(counts.pane).toBe(0); // coalesced: nothing until the frame
    await waitFrames(1);
    expect(counts.pane).toBe(1);
    expect(useTimelineViewStore.getState().pxPerSec).toBeCloseTo(before * 1.2 ** 3, 6);
    const left = scroller().scrollLeft;
    expect(left).toBeGreaterThan(900); // zoom-in about a point right of the left edge
    expect(area().getAttribute(TIMELINE_VIEW_ATTRS.scrollLeft)).toBe(String(Math.round(left)));
  });

  it('playback follow pages the view, and the resulting scroll renders no pane', () => {
    actSync(() => useEditorTimelineStore.getState().setPlaying(true));
    resetCounts();
    // 20 s in: far right of a 1200 px viewport at 90 px/s.
    actSync(() => useEditorTimelineStore.setState({ playhead: 20 * FPS }));
    const written = scroller().scrollLeft;
    expect(written).toBeGreaterThan(0);
    // The browser's echo of that write.
    actSync(() => void scroller().dispatchEvent(new Event('scroll')));
    expect(area().getAttribute(TIMELINE_VIEW_ATTRS.scrollLeft)).toBe(String(Math.round(written)));
    expect(counts.pane).toBe(0);
    actSync(() => useEditorTimelineStore.getState().setPlaying(false));
  });
});
