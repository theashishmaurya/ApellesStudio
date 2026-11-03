// @vitest-environment jsdom
/**
 * @apelles/editor — B-359 item 6: the timeline view follows a playhead JUMP,
 * and the zoom and scroll belong to a timeline.
 *
 * The owner's report: `editor_set_playhead` to 0:06 left the lanes scrolled at
 * 3:55–5:05 (the playhead off screen), and a harness run's 20 % zoom was still
 * there on his own timeline afterwards. B-326's follower only paged during
 * playback. Now any paused jump that lands outside the view centres it (not
 * during a scrub or the user's own scroll), and switching timelines swaps the
 * zoom and the scroll position for that timeline's own.
 *
 * Every jump below goes through `setPlayhead`, the one store action that
 * `editor_set_playhead`, the Index panel's marker rows, ↑/↓ (edit points) and a
 * transcript line all call. jsdom has no layout: the viewport is 1200 px
 * (`stubOffsetMetrics`) and the scroller keeps whatever `scrollLeft` is written.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    chroma_audio_scrub_begin: () => undefined,
    chroma_audio_scrub_update: () => undefined,
    chroma_audio_scrub_end: () => undefined,
  }),
}));

import { useEditorTimelineStore } from './timelineStore';
import { useTimelineViewStore } from './timelineView';
import { TimelinePane } from './TimelinePane';
import { beginScrub, endScrub } from './scrubAudio';
import { TIMELINE_TEST_IDS as ID, TIMELINE_VIEW_ATTRS } from './timelineTestIds';
import { DEFAULT_PX_PER_SEC } from './ruler';
import type { Clip, Timeline } from './timeline';

const FPS = 24;
const VIEWPORT = 1200;
/** The lanes' `START_LEFT_PX` (content x of frame 0). */
const START_LEFT = 32;

/** 10-minute timeline: 60 ten-second clips on V1. */
function fixture(id: string): Timeline {
  const clip = (i: number): Clip =>
    ({ id: `${id}-c${i}`, name: `c${i}`, source_path: '/v.mp4', source_start: 0, duration: 240, source_len: 240, start_frame: i * 240 }) as Clip;
  return {
    id,
    name: id,
    rate: { num: FPS, den: 1 },
    tracks: [{ kind: 'video', clips: Array.from({ length: 60 }, (_, i) => clip(i)) }],
  } as unknown as Timeline;
}

let restores: Array<() => void> = [];
let mounted: MountedComponent | null = null;
let console_: ReturnType<typeof captureConsole>;

const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const scroller = () => q(ID.scroller)!;
const viewScrollLeft = () => Number(q(ID.editArea)!.getAttribute(TIMELINE_VIEW_ATTRS.scrollLeft));
/** A user scroll, as the browser delivers it. */
function userScroll(left: number) {
  actSync(() => {
    scroller().scrollLeft = left;
    scroller().dispatchEvent(new Event('scroll'));
  });
}
/** Content x of `seconds` at the live zoom. */
const xAt = (seconds: number) => START_LEFT + seconds * useTimelineViewStore.getState().pxPerSec;
const seek = (frame: number) => actSync(() => useEditorTimelineStore.getState().setPlayhead(frame));
/** Is the playhead's x inside the scroller's visible window? */
const playheadVisible = () => {
  const x = xAt(useEditorTimelineStore.getState().playhead / FPS);
  return x >= scroller().scrollLeft && x <= scroller().scrollLeft + VIEWPORT;
};

beforeEach(async () => {
  vi.useRealTimers();
  restores = [stubOffsetMetrics(VIEWPORT, 600), installResizeObserverStub(), installPointerCaptureStub()];
  console_ = captureConsole();
  useTimelineViewStore.setState(useTimelineViewStore.getInitialState());
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline: fixture('tl-a'),
      openProjectKey: '/projects/seek-follow.chroma',
      status: 'ready',
      error: null,
      playhead: 0,
      playing: false,
      selection: [],
      selectedGap: null,
    }),
  );
  mounted = mount(React.createElement(TimelinePane), { strictMode: true });
  await waitFrames(2);
});

afterEach(() => {
  endScrub();
  console_.restore();
  mounted?.unmount();
  mounted = null;
  restores.forEach((r) => r());
  actSync(() =>
    useEditorTimelineStore.setState({ timeline: null, openProjectKey: null, status: 'idle', playing: false, selection: [] }),
  );
  useTimelineViewStore.setState(useTimelineViewStore.getInitialState());
});

describe('B-359 item 6 — a paused jump outside the view centres it', () => {
  it('a jump past the right edge (editor_set_playhead to 4:00) centres the playhead', () => {
    seek(240 * FPS);
    expect(scroller().scrollLeft).toBe(Math.round(xAt(240) - VIEWPORT / 2));
    expect(playheadVisible()).toBe(true);
    // The view attributes the harness reads agree once the browser's scroll event lands.
    actSync(() => void scroller().dispatchEvent(new Event('scroll')));
    expect(viewScrollLeft()).toBe(scroller().scrollLeft);
  });

  it("the owner's case: the view at 3:55, a seek to 0:06 brings it back (clamped at the start)", async () => {
    userScroll(Math.round(xAt(235)));
    await new Promise((r) => setTimeout(r, 350)); // past the user-scroll quiet window
    seek(6 * FPS);
    expect(scroller().scrollLeft).toBe(0);
    expect(playheadVisible()).toBe(true);
  });

  it('a jump that is already on screen leaves the view where it is', async () => {
    userScroll(600);
    await new Promise((r) => setTimeout(r, 350));
    seek(Math.round(((600 + 400 - START_LEFT) / DEFAULT_PX_PER_SEC) * FPS));
    expect(scroller().scrollLeft).toBe(600);
  });

  it('does not fight the user: no follow within a moment of their own scroll', () => {
    userScroll(300);
    seek(300 * FPS);
    expect(scroller().scrollLeft).toBe(300);
  });

  it("B-373: another timeline's scroll does not hold back a jump on this one", async () => {
    // The harness's back-to-back run (scroll-horizontal-wheel → seek-far-playhead-visible):
    // a wheel pan on one timeline, that timeline deleted (no timeline open: the
    // pane renders nothing), a new one opened and zoomed 4x, then a far jump,
    // all inside the quiet window that keeps a jump out of the user's own pan.
    userScroll(300);
    actSync(() => useEditorTimelineStore.setState({ timeline: null }));
    await waitFrames(1);
    actSync(() => useEditorTimelineStore.setState({ timeline: fixture('tl-new') }));
    await waitFrames(1);
    actSync(() => useTimelineViewStore.getState().setPxPerSec(DEFAULT_PX_PER_SEC * 4));
    await waitFrames(1);
    expect(scroller().scrollLeft).toBe(0);
    seek(26 * FPS);
    expect(scroller().scrollLeft).toBe(Math.round(xAt(26) - VIEWPORT / 2));
    expect(playheadVisible()).toBe(true);
  });

  it('does not follow during a scrub (the playhead dragged by hand)', () => {
    actSync(() => beginScrub(0));
    seek(300 * FPS);
    expect(scroller().scrollLeft).toBe(0);
    endScrub();
    seek(301 * FPS);
    expect(playheadVisible()).toBe(true);
  });

  it('playback keeps B-326 paging (lead-in on the left), not centring', () => {
    actSync(() => useEditorTimelineStore.getState().setPlaying(true));
    seek(20 * FPS);
    expect(scroller().scrollLeft).toBe(Math.round(20 * DEFAULT_PX_PER_SEC - 48));
    actSync(() => useEditorTimelineStore.getState().setPlaying(false));
  });
});

describe('B-359 item 6 — the zoom and scroll position are per timeline', () => {
  it('a new timeline starts at the default zoom; switching back restores each one', async () => {
    actSync(() => useTimelineViewStore.getState().setPxPerSec(18)); // the harness's 20 %
    userScroll(500);

    actSync(() => useEditorTimelineStore.setState({ timeline: fixture('tl-b') }));
    await waitFrames(2);
    expect(useTimelineViewStore.getState().pxPerSec).toBe(DEFAULT_PX_PER_SEC);
    expect(scroller().scrollLeft).toBe(0);
    actSync(() => useTimelineViewStore.getState().setPxPerSec(270));

    actSync(() => useEditorTimelineStore.setState({ timeline: fixture('tl-a') }));
    await waitFrames(2);
    expect(useTimelineViewStore.getState().pxPerSec).toBe(18);
    expect(scroller().scrollLeft).toBe(500);

    actSync(() => useEditorTimelineStore.setState({ timeline: fixture('tl-b') }));
    await waitFrames(2);
    expect(useTimelineViewStore.getState().pxPerSec).toBe(270);
  });

  it('an edit (same timeline id, new object) keeps the zoom', () => {
    actSync(() => useTimelineViewStore.getState().setPxPerSec(200));
    actSync(() => useEditorTimelineStore.setState({ timeline: { ...fixture('tl-a'), name: 'renamed' } }));
    expect(useTimelineViewStore.getState().pxPerSec).toBe(200);
  });
});
