// @vitest-environment jsdom
/**
 * @chroma/editor — real-DOM regression coverage for timeline markers (D-222),
 * built on `testUtils/pointerHarness.ts` (D-142) and modelled on
 * `TimelinePane.fade.dom.test.tsx`.
 *
 * **Why this file exists.** `timeline.test.ts` is exhaustive at the pure-op
 * level (the reducer, the sort invariant, the colour resolution, the
 * survives-a-clip-edit guarantee), but it cannot prove the two things that
 * actually make this a feature rather than a data structure: that a flag is
 * drawn at the RIGHT PIXEL for its frame — using the same `pxPerSec`/
 * `scrollLeft` math the ruler and the playhead use, not a second derivation —
 * and that the ruler's own gestures write the REAL `Timeline.markers` field
 * through the REAL store rather than moving pictures around in local state.
 * Those are exactly the failure modes an overlay over an existing model
 * invites, so they are asserted here through the real `TimelinePane`, against
 * the real store, with real events.
 *
 * **Tier and its honest limits.** jsdom, not real Chromium — the same
 * disclosure `TimelinePane.fade.dom.test.tsx` and `.marquee.dom.test.tsx` each
 * make, and for the same reason (no layout engine; `stubOffsetMetrics` fakes
 * one viewport). It does NOT prove hit-testing: that a click at a flag's
 * on-screen position reaches the flag rather than the timeline library's own
 * ruler underneath it is a paint-order question jsdom cannot answer. Every
 * gesture below therefore targets the flag ELEMENT directly, which is what the
 * wiring itself owns; the flag's computed `left` is asserted separately, as a
 * value.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

import {
  actSync,
  captureConsole,
  createInvokeStub,
  firePointerEvent,
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
import { DEFAULT_MARKER_COLOR, MARKER_COLORS, type Marker, type Timeline } from './timeline';
import { MARKER_STRIP_HEIGHT } from './TimelineMarkers';

const FPS = 24;
const PX_PER_SEC = 90; // DEFAULT_PX_PER_SEC, as `TimelinePane.tsx` defines it
const START_LEFT_PX = 20; // ditto

/** One video track with a single 4-second clip, plus two markers — one named,
 *  one not — deliberately given in the WRONG frame order so the strip's own
 *  ruler-order guarantee is exercised by the fixture itself. */
function buildFixture(markers: Marker[] = fixtureMarkers()): Timeline {
  return {
    id: 'marker-fixture-tl',
    name: 'marker fixture',
    rate: { num: FPS, den: 1 },
    tracks: [
      {
        kind: 'video',
        clips: [
          { id: 'v', name: 'V', source_path: '/v.mp4', source_start: 0, duration: 96, source_len: 480, start_frame: 0 },
        ],
      },
    ],
    markers,
  };
}

function fixtureMarkers(): Marker[] {
  return [
    { id: 'later', frame: 72, color: DEFAULT_MARKER_COLOR },
    { id: 'earlier', frame: 24, color: DEFAULT_MARKER_COLOR, name: 'sync point' },
  ];
}

let restoreOffsets: () => void;
let restoreResizeObserver: () => void;
let restorePointerCapture: () => void;
let mounted: MountedComponent | null = null;
let console_: ReturnType<typeof captureConsole>;

async function mountWith(timeline: Timeline): Promise<void> {
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline,
      openProjectKey: '/projects/marker-fixture.chroma',
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
}

beforeEach(() => {
  restoreOffsets = stubOffsetMetrics(1200, 600);
  restoreResizeObserver = installResizeObserverStub();
  restorePointerCapture = installPointerCaptureStub();
  console_ = captureConsole();
});

afterEach(() => {
  const errors = console_.errors;
  console_.restore();
  mounted?.unmount();
  mounted = null;
  restorePointerCapture();
  restoreResizeObserver();
  restoreOffsets();
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline: null,
      openProjectKey: null,
      status: 'idle',
      selection: [],
      selectedGap: null,
    }),
  );
  expect(errors, `console.error fired during the test:\n${errors.map((e) => e.join(' ')).join('\n')}`).toEqual([]);
});

/** Every marker flag currently drawn, in DOM order. */
function flags(): HTMLElement[] {
  return Array.from(document.querySelectorAll('[data-chroma-marker]'));
}

function flagFor(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-chroma-marker="${id}"]`);
  if (!el) throw new Error(`no marker flag for "${id}" (have: ${flags().map((f) => f.dataset.chromaMarker).join(', ')})`);
  return el;
}

/** The store's live marker list — the real field, not anything this test kept. */
function markers(): Marker[] {
  return useEditorTimelineStore.getState().timeline?.markers ?? [];
}

function fireMouse(target: EventTarget, type: 'click' | 'dblclick' | 'contextmenu'): void {
  actSync(() => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
  });
}

/** Base UI portals a popover into `document.body`, not into the mount
 *  container — so the editor is looked up globally. */
function editorPopover(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-chroma-marker-editor]');
}

/** The toolbar's marker list trigger. Only rendered once a marker exists, so
 *  finding it is itself part of the assertion. */
function markerListTrigger(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[aria-label="Markers"]');
  expect(el, 'the marker list appears once there is a marker').not.toBeNull();
  return el!;
}

describe('timeline markers — real DOM (D-222)', () => {
  it('1. draws one flag per marker, in frame order, at the frame’s own x', async () => {
    await mountWith(buildFixture());

    // Rendered in FRAME order even though the fixture stored them reversed.
    expect(flags().map((f) => f.dataset.chromaMarker)).toEqual(['earlier', 'later']);

    // The same `startLeft + frame/fps*pxPerSec - scrollLeft` the ruler ticks
    // and the playhead use — 24 frames == 1s == 90px, 72 frames == 3s == 270px.
    expect(flagFor('earlier').style.left).toBe(`${START_LEFT_PX + PX_PER_SEC}px`);
    expect(flagFor('later').style.left).toBe(`${START_LEFT_PX + 3 * PX_PER_SEC}px`);
    // …and each carries its own colour, not a themed one.
    expect(flagFor('earlier').style.background).toBeTruthy();
  });

  it('2. the strip sits in the ruler band, under the ticks and above track row 0', async () => {
    await mountWith(buildFixture());
    const strip = document.querySelector<HTMLElement>('[data-chroma-marker-strip]');
    expect(strip).not.toBeNull();
    // 32px is the timeline library's own ruler height (its bundled CSS), and
    // the strip fills exactly the gap `timeline-overrides.css` opens under it.
    expect(strip!.style.top).toBe('32px');
    expect(strip!.style.height).toBe(`${MARKER_STRIP_HEIGHT}px`);
  });

  it('3. an empty/absent markers list draws no strip content and no jump menu', async () => {
    await mountWith(buildFixture([]));
    expect(flags()).toHaveLength(0);
    // The jump list is hidden entirely when there is nothing to jump to.
    expect(document.querySelector('[aria-label="Go to marker"]')).toBeNull();
    // The ADD affordance is always there — it is not selection- or
    // content-dependent.
    expect(document.querySelector('[aria-label="Add marker"]')).not.toBeNull();
  });

  it('4. clicking a flag jumps the playhead to its frame — and does NOT open the editor', async () => {
    await mountWith(buildFixture());
    expect(useEditorTimelineStore.getState().playhead).toBe(0);

    fireMouse(flagFor('later'), 'click');
    await waitFrames();

    expect(useEditorTimelineStore.getState().playhead).toBe(72);
    // Resolve's own split: a single click positions, it does not open the
    // Markers dialog. Popping a form on every jump would make the common
    // gesture the expensive one.
    expect(editorPopover()).toBeNull();
  });

  it('5. a press on a flag never clears the clip selection (it owns its own press)', async () => {
    await mountWith(buildFixture());
    actSync(() => useEditorTimelineStore.getState().setSelection([{ track: 0, id: 'v' }]));

    firePointerEvent(flagFor('earlier'), 'pointerdown', { x: 110, y: 36 });
    await waitFrames();
    fireMouse(flagFor('earlier'), 'click');
    await waitFrames();

    expect(useEditorTimelineStore.getState().selection).toEqual([{ track: 0, id: 'v' }]);
  });

  it('6. double-clicking a flag opens its editor, and a swatch commits a real set_marker', async () => {
    await mountWith(buildFixture());

    fireMouse(flagFor('earlier'), 'dblclick');
    await waitFrames(2);
    const popover = editorPopover();
    expect(popover, 'double-click must open the marker editor').not.toBeNull();

    const red = MARKER_COLORS.find((c) => c.name === 'red')!;
    const swatch = popover!.querySelector<HTMLElement>('[aria-label="red"]');
    expect(swatch).not.toBeNull();
    fireMouse(swatch!, 'click');
    await waitFrames();

    // The REAL field on the REAL store — not local component state.
    expect(markers().find((m) => m.id === 'earlier')?.color).toBe(red.hex);
    // Nothing else on the marker was restated by a colour click.
    expect(markers().find((m) => m.id === 'earlier')?.name).toBe('sync point');
    expect(markers().find((m) => m.id === 'later')?.color).toBe(DEFAULT_MARKER_COLOR);
  });

  it('7. right-clicking a flag opens the same editor, whose Delete removes the marker', async () => {
    await mountWith(buildFixture());

    fireMouse(flagFor('later'), 'contextmenu');
    await waitFrames(2);
    const popover = editorPopover();
    expect(popover).not.toBeNull();

    const del = Array.from(popover!.querySelectorAll('button')).find((b) => b.textContent?.includes('Delete'));
    expect(del).toBeDefined();
    fireMouse(del!, 'click');
    await waitFrames(2);

    expect(markers().map((m) => m.id)).toEqual(['earlier']);
    // The popover cannot outlive the marker it was editing.
    expect(editorPopover()).toBeNull();
  });

  it('8. the toolbar button adds a marker AT THE PLAYHEAD, with the default colour', async () => {
    await mountWith(buildFixture([]));
    actSync(() => useEditorTimelineStore.getState().setPlayhead(48));

    const add = document.querySelector<HTMLElement>('[aria-label="Add marker"]');
    fireMouse(add!, 'click');
    await waitFrames();

    expect(markers()).toHaveLength(1);
    expect(markers()[0].frame).toBe(48);
    expect(markers()[0].color).toBe(DEFAULT_MARKER_COLOR);
    // …and it is on screen immediately, at that frame's own x (48f == 2s).
    expect(flags()).toHaveLength(1);
    expect(flags()[0].style.left).toBe(`${START_LEFT_PX + 2 * PX_PER_SEC}px`);
  });

  it('9. the `M` shortcut adds one too — but not while typing in a field', async () => {
    await mountWith(buildFixture([]));
    actSync(() => useEditorTimelineStore.getState().setPlayhead(12));

    const pane = mounted!.container.querySelector<HTMLElement>('[tabindex="0"]');
    expect(pane).not.toBeNull();
    actSync(() => {
      pane!.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }));
    });
    await waitFrames();
    expect(markers().map((m) => m.frame)).toEqual([12]);

    // A modified press is somebody else's chord (⌘M minimises on macOS).
    actSync(() => {
      pane!.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', metaKey: true, bubbles: true }));
    });
    await waitFrames();
    expect(markers()).toHaveLength(1);

    // …and an `m` typed into a real text field is an "m", not a marker.
    const input = document.createElement('input');
    pane!.appendChild(input);
    actSync(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }));
    });
    await waitFrames();
    expect(markers()).toHaveLength(1);
    input.remove();
  });

  it('10. the marker list offers every marker in frame order and jumps to one', async () => {
    await mountWith(buildFixture());

    fireMouse(markerListTrigger(), 'click');
    await waitFrames(2);

    const items = Array.from(document.querySelectorAll<HTMLElement>('[data-chroma-marker-list-item]'));
    expect(items.map((i) => i.dataset.chromaMarkerListItem)).toEqual(['earlier', 'later']);
    expect(items[0].textContent).toContain('sync point');

    fireMouse(items[1], 'click');
    await waitFrames();
    expect(useEditorTimelineStore.getState().playhead).toBe(72);
  });

  // ---- B-113: deleting a marker from the list ---------------------------- //
  //
  // The popover's own Delete (test 6 above) already existed and already
  // worked. What did not exist was any way to REACH a delete without knowing
  // to double-click a 9px flag — the owner, testing live with a marker
  // placed, reported "no way to remove a marker once placed" while looking at
  // this very list. These three cover the affordance that closes that gap.

  it('11. B-113 — each row in the marker list carries its own Delete', async () => {
    await mountWith(buildFixture());
    fireMouse(markerListTrigger(), 'click');
    await waitFrames(2);

    const removes = Array.from(document.querySelectorAll<HTMLElement>('[data-chroma-marker-list-remove]'));
    expect(
      removes.map((r) => r.dataset.chromaMarkerListRemove),
      'one delete per row, in the same frame order the rows are in',
    ).toEqual(['earlier', 'later']);
  });

  it('12. B-113 — clicking a row’s Delete writes the real remove_marker op', async () => {
    await mountWith(buildFixture());
    fireMouse(markerListTrigger(), 'click');
    await waitFrames(2);

    fireMouse(
      document.querySelector<HTMLElement>('[data-chroma-marker-list-remove="earlier"]')!,
      'click',
    );
    await waitFrames(2);

    // The REAL `Timeline.markers` field, through the real store — not a
    // picture removed from a local list.
    expect(markers().map((m) => m.id)).toEqual(['later']);
    // …and the flag really is gone from the strip.
    expect(flags().map((f) => f.dataset.chromaMarker)).toEqual(['later']);
  });

  it('13. B-113 — a row’s Delete does NOT also jump the playhead to the marker it deleted', async () => {
    await mountWith(buildFixture());
    expect(useEditorTimelineStore.getState().playhead).toBe(0);
    fireMouse(markerListTrigger(), 'click');
    await waitFrames(2);

    fireMouse(
      document.querySelector<HTMLElement>('[data-chroma-marker-list-remove="later"]')!,
      'click',
    );
    await waitFrames(2);

    // The row's own click handler jumps; the delete sits inside that row and
    // must stop the event, or deleting would also scrub the user to frame 72.
    expect(useEditorTimelineStore.getState().playhead).toBe(0);
    expect(markers().map((m) => m.id)).toEqual(['earlier']);
  });
});
