// @vitest-environment jsdom
/**
 * @apelles/editor — the timeline toolbar regrouped to the approved mockup
 * (v0.3.0: B-354, B-359 item 4; `docs/notes/ui-redesign.md` §4.9, §6e).
 *
 * Pins the structure the mockup draws — three columns (tools and actions ·
 * switcher and timecode · view toggles and zoom), the trim tools as ONE
 * segmented group, the zoom slider in place of the `20%` readout, the beat
 * grid's tempo / snap / snap-cuts inside one Beat grid popover — and that the
 * slider drives the same zoom store as the +/- buttons and the MCP tool.
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
import { useTimelineViewStore } from './timelineView';
import { TIMELINE_TEST_IDS } from './timelineTestIds';
import { pxPerSecAtSliderPosition, zoomSliderPosition } from './TimelineViewControls';
import type { Timeline } from './timeline';

function fixture(): Timeline {
  return {
    id: 'toolbar-fixture-tl',
    name: 'toolbar fixture',
    rate: { num: 24, den: 1 },
    tracks: [
      {
        kind: 'video',
        clips: [{ id: 'v', name: 'V', source_path: '/v.mp4', source_start: 0, duration: 240, source_len: 240, start_frame: 0 }],
      },
    ],
  } as unknown as Timeline;
}

let ui: MountedComponent | null = null;
let restore: Array<() => void> = [];

async function mountPane(): Promise<HTMLElement> {
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline: fixture(),
      openProjectKey: '/projects/toolbar.chroma',
      status: 'ready',
      error: null,
      playhead: 0,
      playing: false,
      selection: [],
      selectedGap: null,
    }),
  );
  ui = mount(
    React.createElement(TimelinePane, { toolbarCenter: React.createElement('span', { 'data-testid': 'centre' }, 'centre') }),
    { strictMode: true },
  );
  await waitFrames(2);
  return ui.container.querySelector('[data-chroma-timeline-toolbar]') as HTMLElement;
}

beforeEach(() => {
  useTimelineViewStore.setState(useTimelineViewStore.getInitialState());
  restore = [stubOffsetMetrics(1200, 600), installResizeObserverStub(), installPointerCaptureStub()];
});

afterEach(() => {
  ui?.unmount();
  ui = null;
  for (const r of restore) r();
  actSync(() => useEditorTimelineStore.setState({ timeline: null, openProjectKey: null, status: 'idle', selection: [] }));
});

const byTestId = (root: ParentNode, id: string) => root.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe('the timeline toolbar, regrouped (v0.3.0)', () => {
  it('is three columns, the centre in its own middle column', async () => {
    const bar = await mountPane();
    expect(bar.className).toContain('grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]');
    expect(bar.className).toContain('h-9');
    const groups = [...bar.children].map((c) => c.getAttribute('data-chroma-toolbar-group'));
    expect(groups).toEqual(['left', 'center', 'right']);
    expect(bar.querySelector('[data-chroma-toolbar-group="center"] [data-testid="centre"]')).toBeTruthy();
  });

  it('left: the six tools as ONE segmented group first, then Split, Marker, Transitions', async () => {
    const bar = await mountPane();
    const left = bar.querySelector('[data-chroma-toolbar-group="left"]') as HTMLElement;
    const tools = left.firstElementChild as HTMLElement;
    expect(tools.getAttribute('data-chroma-trim-toolbar')).toBe('');
    expect(tools.className).toContain('rounded-sm');
    expect(tools.className).toContain('bg-bg-secondary');
    expect([...tools.querySelectorAll('[data-chroma-trim-tool]')].map((b) => b.getAttribute('data-chroma-trim-tool'))).toEqual([
      'select',
      'ripple',
      'roll',
      'slip',
      'slide',
      'blade',
    ]);
    const order = [byTestId(left, TIMELINE_TEST_IDS.split), byTestId(left, TIMELINE_TEST_IDS.addMarker)];
    expect(order.every(Boolean)).toBe(true);
    // Split comes after the tools, Marker after Split.
    expect(tools.compareDocumentPosition(order[0] as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect((order[0] as Node).compareDocumentPosition(order[1] as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('Remove is contextual: absent at rest, present with a clip selected', async () => {
    const bar = await mountPane();
    expect(byTestId(bar, TIMELINE_TEST_IDS.delete)).toBeNull();
    actSync(() => useEditorTimelineStore.setState({ selection: [{ track: 0, id: 'v' }] }));
    await waitFrames(1);
    expect(byTestId(bar, TIMELINE_TEST_IDS.delete)).toBeTruthy();
  });

  it('right: Snapping, Skimming, Beat grid, Clip Appearance, then − slider +; no percentage readout', async () => {
    const bar = await mountPane();
    const right = bar.querySelector('[data-chroma-toolbar-group="right"]') as HTMLElement;
    const ids = [
      TIMELINE_TEST_IDS.snappingToggle,
      TIMELINE_TEST_IDS.skimmingToggle,
      TIMELINE_TEST_IDS.beatGrid,
      TIMELINE_TEST_IDS.clipAppearance,
      TIMELINE_TEST_IDS.zoomOut,
      TIMELINE_TEST_IDS.toolbarZoomSlider,
      TIMELINE_TEST_IDS.zoomIn,
    ];
    const els = ids.map((id) => byTestId(right, id));
    expect(els.every(Boolean), ids.filter((_, i) => !els[i]).join(', ')).toBe(true);
    for (let i = 1; i < els.length; i++) {
      expect((els[i - 1] as Node).compareDocumentPosition(els[i] as Node) & Node.DOCUMENT_POSITION_FOLLOWING, ids[i]).toBeTruthy();
    }
    expect(right.textContent).not.toMatch(/\d+%/);
    expect(right.textContent).not.toMatch(/BPM/);
  });

  it('the zoom slider drives the same zoom store as +/- and editor_set_timeline_view, and says the %', async () => {
    const bar = await mountPane();
    const slider = byTestId(bar, TIMELINE_TEST_IDS.toolbarZoomSlider) as HTMLElement;
    const input = slider.querySelector('input') as HTMLInputElement;
    expect(input.getAttribute('aria-label')).toBe('Timeline zoom');
    expect(input.getAttribute('aria-valuetext')).toBe('100%');
    const before = useTimelineViewStore.getState().pxPerSec;
    actSync(() => input.focus());
    actSync(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true, cancelable: true }));
    });
    await waitFrames(2);
    const after = useTimelineViewStore.getState().pxPerSec;
    expect(after).toBeGreaterThan(before);
    expect(after).toBeCloseTo(pxPerSecAtSliderPosition(zoomSliderPosition(before) + 50), 3);
    // …and a store write (what the +/- buttons and the MCP tool do) moves the thumb.
    actSync(() => useTimelineViewStore.getState().setPxPerSec(before));
    await waitFrames(1);
    expect(input.getAttribute('aria-valuetext')).toBe('100%');
  });

  it('the Beat grid popover explains how to turn it on when no track has one', async () => {
    const bar = await mountPane();
    const btn = byTestId(bar, TIMELINE_TEST_IDS.beatGrid) as HTMLElement;
    expect(btn.hasAttribute('data-chroma-active')).toBe(false);
    actSync(() => btn.click());
    await waitFrames(2);
    const pop = document.querySelector(`[data-testid="${TIMELINE_TEST_IDS.beatGridPopover}"]`);
    expect(pop?.textContent).toMatch(/No beat grid/);
  });
});

describe('the zoom slider mapping', () => {
  it('is logarithmic and round-trips', () => {
    for (const px of [10, 90, 400, 2000]) {
      expect(pxPerSecAtSliderPosition(zoomSliderPosition(px))).toBeCloseTo(px, -Math.log10(px) + 1);
    }
  });
});
