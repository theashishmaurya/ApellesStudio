// @vitest-environment jsdom
/**
 * @apelles/editor — clicking the timeline moves the playhead, and the view
 * follows it during playback (B-326).
 *
 * Same harness/geometry as `TimelinePane.gap.dom.test.tsx`: jsdom has no layout
 * engine, so the click is dispatched straight on the edit area with
 * coordinates computed from the pane's own constants.
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
  }),
}));

import { useKeymapStore } from '@apelles/keymap';
import { useEditorTimelineStore } from './timelineStore';
import { TimelinePane } from './TimelinePane';
import type { Timeline } from './timeline';

const FPS = 24;
const ROW_HEIGHT = 52;
const START_LEFT_PX = 32;
const RULER_AND_MARGIN_PX = 32 + 16;
const PX_PER_SEC = 90; // DEFAULT_PX_PER_SEC

const fixture: Timeline = {
  id: 'seek-pane-tl',
  name: 'seek pane',
  rate: { num: FPS, den: 1 },
  tracks: [
    {
      kind: 'video',
      clips: [
        { id: 'a', name: 'A', source_path: '/a.mp4', source_start: 0, duration: 100, source_len: 100, start_frame: 0 },
        { id: 'b', name: 'B', source_path: '/b.mp4', source_start: 0, duration: 100, source_len: 100, start_frame: 600 },
      ],
    },
  ],
};

let restores: (() => void)[] = [];
let mounted: MountedComponent | null = null;
let editArea: HTMLElement;
let console_: ReturnType<typeof captureConsole>;

beforeEach(async () => {
  restores = [stubOffsetMetrics(1200, 600), installResizeObserverStub(), installPointerCaptureStub()];
  console_ = captureConsole();
  useKeymapStore.setState({ overrides: {}, activeScope: 'edit', osPlatform: 'macos' });
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline: { ...fixture, tracks: [{ kind: 'video', clips: [...fixture.tracks[0].clips] }] },
      openProjectKey: '/projects/seek-pane.chroma',
      status: 'ready',
      error: null,
      playhead: 10,
      playing: false,
      selection: [],
      selectedGap: null,
    }),
  );
  mounted = mount(React.createElement(TimelinePane), { strictMode: true });
  await waitFrames(2);
  const found = mounted.container.querySelector('[data-testid="timeline-edit-area"]');
  if (!found) throw new Error('timeline-edit-area never rendered');
  editArea = found as HTMLElement;
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

function clickAt(frame: number, track: number): void {
  const x = START_LEFT_PX + (frame / FPS) * PX_PER_SEC;
  const y = RULER_AND_MARGIN_PX + track * ROW_HEIGHT + ROW_HEIGHT / 2;
  actSync(() => editArea.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y })));
}

describe('click-to-seek on the track area (B-326)', () => {
  it('empty track space (a gap between clips) moves the playhead there', () => {
    clickAt(300, 0);
    expect(useEditorTimelineStore.getState().playhead).toBe(300);
  });

  it('while playing, the click seeks and keeps playing (re-baselined)', () => {
    actSync(() => useEditorTimelineStore.getState().setPlaying(true));
    const epoch = useEditorTimelineStore.getState().seekEpoch;
    clickAt(300, 0);
    const s = useEditorTimelineStore.getState();
    expect(s.playhead).toBe(300);
    expect(s.playing).toBe(true);
    expect(s.seekEpoch).toBe(epoch + 1);
  });
});

describe('the view follows the playhead during playback (B-326)', () => {
  // D-437 S4 — the lanes' own native scroller (it was the library's grid).
  const scroller = (): HTMLElement | null => editArea.querySelector('[data-testid="timeline-scroller"]');

  it('pages when the playhead leaves the window while playing; a paused jump centres it (B-359 item 6)', () => {
    actSync(() => useEditorTimelineStore.setState({ playhead: 640 }));
    // Paused: B-359 item 6 — a jump outside the view centres it (it used to stay put).
    const centred = scroller()?.scrollLeft ?? 0;
    expect(centred).toBeGreaterThan(0);
    actSync(() => void scroller()?.dispatchEvent(new Event('scroll')));
    actSync(() => useEditorTimelineStore.getState().setPlaying(true));
    actSync(() => useEditorTimelineStore.setState({ playhead: 1400 }));
    // Playing: B-326's page, the playhead a lead-in from the left edge.
    expect(scroller()?.scrollLeft ?? 0).toBeGreaterThan(centred);
  });
});

describe('clicking ON a clip keeps its select-only default (B-326)', () => {
  it('does not move the playhead', () => {
    const action = editArea.querySelector('[data-testid="timeline-clip-slot"]');
    if (!action) throw new Error('no rendered clip to click');
    actSync(() => action.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 100, clientY: 80 })));
    expect(useEditorTimelineStore.getState().playhead).toBe(10);
  });
});
