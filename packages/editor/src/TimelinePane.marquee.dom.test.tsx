// @vitest-environment jsdom
/**
 * @chroma/editor — permanent real-DOM regression coverage for marquee-select
 * (D-137, roadmap item 12 Phase 2), built on `testUtils/pointerHarness.ts`
 * (D-142).
 *
 * **Why this file exists.** `marquee.ts`'s own `marquee.test.ts` (D-137) is
 * exhaustive at the pure-function level — intersection math, activation
 * threshold, modifier composition, pixel↔timeline conversion — but it tests
 * a HAND-WRITTEN fake `closest()`, not a real DOM, by its own module doc's
 * admission ("that is a *fake* `closest`, because there is no DOM in this
 * package's vitest environment"). D-137's own real verification — the thing
 * that actually proves a marquee doesn't hijack a dnd-kit clip drag, that
 * Escape leaves the world untouched, that a zoom mid-drag doesn't go stale —
 * was 14 scenarios driven live against a real Chromium tab via a scratch
 * harness, deleted after use, per this repo's own established (and
 * repeatedly rebuilt — D-095/096/098/100/137) pattern. This file is that
 * verification, MADE PERMANENT: it mounts the real `TimelinePane` (not a
 * stand-in), seeds a real fixture into the real store, and drives it with
 * real `PointerEvent`s via `pointerHarness.ts`, so the next person to touch
 * this gesture gets a real regression signal from `npm test`, not a
 * from-scratch rebuild.
 *
 * **Tier and its honest limits — read before trusting this file to prove
 * more than it does.** This is the jsdom tier, not the real-Chromium tier
 * (`app/harness.html`, see its own header). jsdom has no layout engine —
 * every element's on-screen box is `0×0` unless stubbed
 * (`stubOffsetMetrics`) — so `@xzdarcy/react-timeline-editor`'s
 * `react-virtualized`-backed rows only paint real clip DOM at all because
 * this file stubs `offsetWidth`/`clientWidth`/etc. to one fixed viewport.
 * That stub is also WHY dnd-kit's own rect-based drop-target resolution
 * cannot be trusted here (every droppable measures to the same degenerate
 * geometry) — so this file proves the MARQUEE side of the coexistence rule
 * (a press on a clip, or a right-click, never starts a rubber-band) but does
 * NOT attempt to assert a dnd-kit drag's own outcome (a clip actually
 * landing on a different track, a track actually reordering). That is a
 * real, disclosed gap, covered instead by the interactive real-browser tier.
 *
 * Geometry below (`ROW_HEIGHT`/`START_LEFT_PX`/`RULER_AND_MARGIN_PX`/
 * `PX_PER_SEC`) mirrors `TimelinePane.tsx`'s own private module-scope
 * constants exactly (52 / 20 / 42 / `DEFAULT_PX_PER_SEC`=90) — stated
 * explicitly here rather than imported, the same call `marquee.test.ts`
 * itself already made for the identical reason (that file's own module doc:
 * "so the tests can state them explicitly").
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

import {
  actSync,
  captureConsole,
  createInvokeStub,
  dragPointer,
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

// Imported AFTER the mock above is declared (vi.mock is hoisted by vitest,
// so import order in source doesn't actually matter here, but keeping the
// mock textually first documents the real requirement).
import { useEditorTimelineStore } from './timelineStore';
import { TimelinePane } from './TimelinePane';
import type { Timeline } from './timeline';
import { MARQUEE_MIN_DRAG_PX } from './marquee';

const FPS = 24;
const ROW_HEIGHT = 52;
const START_LEFT_PX = 20;
const RULER_AND_MARGIN_PX = 42;
const PX_PER_SEC = 90; // DEFAULT_PX_PER_SEC

/** frame → the `clientX` that lands exactly on it, given `editAreaRef`'s
 *  `getBoundingClientRect()` is always `{top:0,left:0,...}` under jsdom (no
 *  real layout engine) — so a dispatched event's raw `clientX`/`clientY` IS
 *  already edit-area-relative, with no rect subtraction needed. Mirrors
 *  `marqueeAnchorFromPoint`'s own formula, inverted. */
function xAtFrame(frame: number): number {
  return START_LEFT_PX + (frame / FPS) * PX_PER_SEC;
}

/** track index → a `clientY` inside that row (default: its vertical centre). */
function yAtTrack(track: number, withinRow = ROW_HEIGHT / 2): number {
  return RULER_AND_MARGIN_PX + track * ROW_HEIGHT + withinRow;
}

// A fixed 3-track fixture, laid out so a marquee drawn over track 0-1's
// clips never reaches track 2's, and vice versa — every scenario below
// states its own expected hit set from this one fixture rather than a
// bespoke layout per test, so the geometry stays checkable by inspection.
//   track 0: 'a' [0,48)     (0-2s)   track 0: 'b' [240,288) (10-12s, far away)
//   track 1: 'c' [24,72)    (1-3s)
//   track 2: 'd' [120,168)  (5-7s)
function buildFixture(): Timeline {
  return {
    id: 'fixture-tl',
    name: 'fixture',
    rate: { num: FPS, den: 1 },
    tracks: [
      {
        kind: 'video',
        clips: [
          { id: 'a', name: 'A', source_path: '/a.mp4', source_start: 0, duration: 48, source_len: 480, start_frame: 0 },
          { id: 'b', name: 'B', source_path: '/b.mp4', source_start: 0, duration: 48, source_len: 480, start_frame: 240 },
        ],
      },
      {
        kind: 'video',
        clips: [
          { id: 'c', name: 'C', source_path: '/c.mp4', source_start: 0, duration: 48, source_len: 480, start_frame: 24 },
        ],
      },
      {
        kind: 'video',
        clips: [
          { id: 'd', name: 'D', source_path: '/d.mp4', source_start: 0, duration: 48, source_len: 480, start_frame: 120 },
        ],
      },
    ],
  };
}

let restoreOffsets: () => void;
let restoreResizeObserver: () => void;
let restorePointerCapture: () => void;
let mounted: MountedComponent | null = null;
let editArea: HTMLElement;
let console_: ReturnType<typeof captureConsole>;

beforeEach(async () => {
  restoreOffsets = stubOffsetMetrics(1200, 600);
  restoreResizeObserver = installResizeObserverStub();
  restorePointerCapture = installPointerCaptureStub();
  console_ = captureConsole();

  actSync(() => useEditorTimelineStore.setState({
    timeline: buildFixture(),
    openProjectKey: '/projects/marquee-fixture.chroma',
    status: 'ready',
    error: null,
    playhead: 0,
    playing: false,
    selection: [],
    selectedGap: null,
  }));

  mounted = mount(React.createElement(TimelinePane), { strictMode: true });
  await waitFrames(2);
  const found = mounted.container.querySelector('[data-bench-id="timeline-edit-area"]');
  if (!found) throw new Error('timeline-edit-area never rendered — fixture/harness setup is broken');
  editArea = found as HTMLElement;
});

afterEach(() => {
  // Every prior harness's own bar for "clean" included zero console
  // errors/warnings under real StrictMode double-invoke — make that a real,
  // enforced assertion here rather than an eyeballed log read.
  const errors = console_.errors;
  console_.restore();
  mounted?.unmount();
  mounted = null;
  restorePointerCapture();
  restoreResizeObserver();
  restoreOffsets();
  actSync(() => useEditorTimelineStore.setState({
    timeline: null,
    openProjectKey: null,
    status: 'idle',
    selection: [],
    selectedGap: null,
  }));
  expect(errors, `console.error fired during the test:\n${errors.map((e) => e.join(' ')).join('\n')}`).toEqual([]);
});

function selection() {
  return useEditorTimelineStore.getState().selection;
}

describe('marquee-select — real DOM, real PointerEvents (D-137 via D-142 harness)', () => {
  it('1. a plain drag over empty canvas selects exactly the clips it geometrically overlaps, replacing any prior selection', async () => {
    actSync(() => useEditorTimelineStore.setState({ selection: [{ track: 2, id: 'd' }] }));

    // Rect spans clientX [90,250] (frame ~18.7 to ~61.3) and clientY [30,130]
    // (row ~-0.23 to ~1.69): overlaps track 0's row and track 1's, not
    // track 2's. Frame range overlaps 'a' [0,48) and 'c' [24,72), misses 'b'
    // [240,288) entirely.
    await dragPointer(editArea, [
      { x: 90, y: 30 },
      { x: 170, y: 80 },
      { x: 250, y: 130 },
    ]);

    expect(mounted!.container.querySelector('[data-bench-id="timeline-marquee"]')).toBeNull();
    expect(selection()).toEqual([
      { track: 0, id: 'a' },
      { track: 1, id: 'c' },
    ]);
  });

  it('2. shift-drag unions onto the existing selection instead of replacing it', async () => {
    actSync(() => useEditorTimelineStore.setState({ selection: [{ track: 2, id: 'd' }] }));

    await dragPointer(
      editArea,
      [
        { x: 90, y: 30 },
        { x: 250, y: 130 },
      ],
      { shiftKey: true },
    );

    expect(selection()).toEqual([
      { track: 2, id: 'd' },
      { track: 0, id: 'a' },
      { track: 1, id: 'c' },
    ]);
  });

  it('3. cmd/meta-drag also unions (not just shift)', async () => {
    actSync(() => useEditorTimelineStore.setState({ selection: [{ track: 0, id: 'b' }] }));

    await dragPointer(
      editArea,
      [
        { x: 90, y: 30 },
        { x: 250, y: 130 },
      ],
      { metaKey: true },
    );

    expect(selection()).toEqual([
      { track: 0, id: 'b' },
      { track: 0, id: 'a' },
      { track: 1, id: 'c' },
    ]);
  });

  it('4. a press that never crosses the activation threshold is a click, not a marquee: no band, and the existing selection still clears', async () => {
    actSync(() => useEditorTimelineStore.setState({ selection: [{ track: 0, id: 'a' }] }));
    expect(MARQUEE_MIN_DRAG_PX).toBeGreaterThan(1); // the test's own premise

    // Far past every clip/track (row index 4, tracks.length === 3) so the
    // real onClick handler's own fallthrough is "plain clear", not "select a
    // gap" — isolates this test to the marquee-vs-click question only.
    const x = xAtFrame(600);
    const y = yAtTrack(4);
    await dragPointer(editArea, [
      { x, y },
      { x: x + 1, y: y + 1 },
    ]);
    // jsdom does not synthesize a `click` from raw pointerdown/pointerup
    // dispatch the way a real browser does after an actual mouse click —
    // dispatched explicitly here, matching what a real click on this exact
    // press (never activated the marquee, so nothing suppresses it) does.
    actSync(() => editArea.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x + 1, clientY: y + 1 })));
    await waitFrames();

    expect(mounted!.container.querySelector('[data-bench-id="timeline-marquee"]')).toBeNull();
    expect(selection()).toEqual([]);
  });

  it('5. a press on a real rendered clip never starts a marquee — the D-100/D-137 dnd-kit coexistence rule, checked against real DOM', async () => {
    // If this predicate were ever wrong, this exact drag path — the same
    // rect as scenario 1 — would replace the selection with [a, c]. Proving
    // it does NOT is what proves the marquee path was never taken; this test
    // deliberately does not assert what dnd-kit itself does with the press
    // (see this file's own header on the dnd-kit-collision gap).
    actSync(() => useEditorTimelineStore.setState({ selection: [{ track: 2, id: 'd' }] }));

    const clip = mounted!.container.querySelector('[data-chroma-clip-drag]');
    expect(clip, 'fixture did not render a real clip to press on').not.toBeNull();

    await dragPointer(clip!, [
      { x: 90, y: 30 },
      { x: 250, y: 130 },
    ]);

    expect(mounted!.container.querySelector('[data-bench-id="timeline-marquee"]')).toBeNull();
    expect(selection()).toEqual([{ track: 2, id: 'd' }]); // untouched by marquee logic
  });

  it('6. a right-button press never starts a marquee', async () => {
    actSync(() => useEditorTimelineStore.setState({ selection: [{ track: 2, id: 'd' }] }));

    await dragPointer(
      editArea,
      [
        { x: 90, y: 30 },
        { x: 250, y: 130 },
      ],
      { button: 2, buttons: 2 },
    );

    expect(mounted!.container.querySelector('[data-bench-id="timeline-marquee"]')).toBeNull();
    // A right-click never reaches the left-click `onClick` clear branch
    // either — real browsers don't fire `click` for a non-primary button.
    expect(selection()).toEqual([{ track: 2, id: 'd' }]);
  });

  it('7. Escape abandons an in-flight marquee without committing, and the click that follows the pointerup does not wipe the pre-existing selection', async () => {
    actSync(() => useEditorTimelineStore.setState({ selection: [{ track: 2, id: 'd' }] }));

    firePointerEvent(editArea, 'pointerdown', { x: 90, y: 30 });
    await waitFrames();
    firePointerEvent(window, 'pointermove', { x: 250, y: 130 });
    await waitFrames();
    expect(mounted!.container.querySelector('[data-bench-id="timeline-marquee"]')).not.toBeNull(); // really activated

    // KeyboardEvent, not PointerEvent — dispatch directly.
    actSync(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await waitFrames();
    expect(mounted!.container.querySelector('[data-bench-id="timeline-marquee"]')).toBeNull();

    // The real `pointerup` that follows a real Escape (the button is still
    // physically down) must not run the edit area's own clear-on-click
    // fallthrough — the exact live-found bug D-137's own doc records.
    firePointerEvent(window, 'pointerup', { x: 250, y: 130 });
    actSync(() => editArea.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 250, clientY: 130 })));
    await waitFrames();

    expect(selection()).toEqual([{ track: 2, id: 'd' }]);
  });

  it('8. a completed marquee supersedes a selected gap (D-105/D-137 mutual exclusion)', async () => {
    actSync(() => useEditorTimelineStore.setState({ selection: [], selectedGap: { track: 0, frame: 300 } }));

    await dragPointer(editArea, [
      { x: 90, y: 30 },
      { x: 250, y: 130 },
    ]);

    expect(useEditorTimelineStore.getState().selectedGap).toBeNull();
    expect(selection()).toEqual([
      { track: 0, id: 'a' },
      { track: 1, id: 'c' },
    ]);
  });

  it('9. a ctrl-wheel zoom mid-drag is read live, not from a stale closure — the band rescales with the content it encloses', async () => {
    // `TimelinePane.tsx`'s own `ZOOM_STEP` (1.2) — each ctrl-wheel tick
    // multiplies `pxPerSec` by this. Four ticks ≈ 1.2^4 ≈ 2.07x, a change
    // large enough to be unambiguous against jsdom's own pixel rounding.
    const ZOOM_STEP = 1.2;
    const ticks = 4;

    // Capture the marquee's rendered pixel band BEFORE and AFTER a real
    // mid-drag zoom, same anchor and same live pointer position throughout —
    // proving `marqueeOverlayBox` re-derives from the LIVE viewport
    // (`marqueeLatestRef`) on every render, not a `pxPerSec` value closed
    // over back at `pointerdown` (a stale closure would leave this
    // unchanged).
    firePointerEvent(editArea, 'pointerdown', { x: xAtFrame(0), y: 30 });
    await waitFrames();
    firePointerEvent(window, 'pointermove', { x: xAtFrame(110), y: 130 });
    await waitFrames();
    const bandBefore = mounted!.container.querySelector('[data-bench-id="timeline-marquee"]') as HTMLElement;
    expect(bandBefore).not.toBeNull();
    const widthBefore = parseFloat(bandBefore.style.width);
    expect(widthBefore).toBeCloseTo(xAtFrame(110) - xAtFrame(0), 0);

    // Real ctrl-wheel events, dispatched at the edit area (`TimelinePane`'s
    // own native `wheel` listener is bound there, not via React's `onWheel`
    // — see that effect's own doc on why) — `deltaY < 0` zooms in. No new
    // `pointermove` between ticks: the `marquee` rect (a fixed frame/row
    // pair, set by the LAST real move) never changes here, only the pixels
    // it paints at — if the overlay's width still tracked the zoom with zero
    // new pointer input, that proves it derives from the LIVE `pxPerSec` on
    // every render (`marqueeOverlayBox(marquee, marqueeViewport)`), not one
    // closed over back at `pointerdown` — a stale closure would leave the
    // band frozen at `widthBefore` until the next explicit move.
    for (let i = 0; i < ticks; i++) {
      actSync(() => editArea.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100 })));
      await waitFrames();
    }

    const bandAfter = mounted!.container.querySelector('[data-bench-id="timeline-marquee"]') as HTMLElement;
    expect(bandAfter).not.toBeNull();
    const widthAfter = parseFloat(bandAfter.style.width);
    expect(widthAfter).toBeCloseTo(widthBefore * ZOOM_STEP ** ticks, 0);

    firePointerEvent(window, 'pointerup', { x: xAtFrame(110), y: 130 });
    await waitFrames();
  });
});
