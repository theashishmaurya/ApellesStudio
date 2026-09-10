// @vitest-environment jsdom
/**
 * @apelles/editor — real-DOM coverage for where a dragged clip actually LANDS
 * (B-145 / D-302), on the same harness and in the same tier as
 * `TimelinePane.dragGhost.dom.test.tsx` and `TimelinePane.trim.dom.test.tsx`.
 *
 * **Why this had to be a DOM test.** B-145 — "when i move this instead of
 * moving it moves to very starting" — is not a bug in any placement function.
 * `resolveClipLanding`/`computeInsertion` were handed a wrong `intendedFrame`
 * and answered it correctly; the wrongness was born in `@dnd-kit/core`'s
 * `event.delta`, which only goes wrong once a real drag runs against a real
 * scroll container with a real droppable resolved. Nothing below the component
 * can observe that, so the assertion here is the one the owner made: drive a
 * real `PointerEvent` drag and read the clip's `start_frame` out of the store
 * afterwards.
 *
 * **The two jsdom-tier stubs this file adds, and why each is honest.** jsdom
 * has no layout engine, so two geometric facts a browser supplies for free have
 * to be supplied here (the same category as `stubOffsetMetrics`, which this
 * suite has always needed):
 *
 *  1. `scrollTimelineGridTo` gives the timeline library's own scrolling grid a
 *     real `scrollLeft`. jsdom's is permanently 0 because nothing overflows
 *     anything. dnd-kit reads exactly this property (`getScrollOffset`), so
 *     with it defined the library's grid is a genuinely scrolled scrollable
 *     ancestor of the dragged clip — which is the whole precondition of B-145.
 *  2. `alignDropZonesToRows` gives each `TrackDropZone` the box its own track
 *     row really occupies. In a browser they coincide by construction (the zone
 *     is an overlay positioned onto the row); in jsdom the row's box comes from
 *     the inline `top`/`height` the library writes while the zone's comes from
 *     Tailwind classes jsdom never resolves, so they have to be tied together
 *     explicitly or dnd-kit's rect-based collision detection resolves no `over`
 *     at all and every drop is a cancel.
 *
 * **Which test is the regression test, and why not all of them are.** The
 * corruption only happens once dnd-kit's `scrollableAncestors` set CHANGES
 * mid-drag — it captures the drag's "initial" scroll offset from the dragged
 * clip's own chain (which contains the library's scrolling grid) and then
 * measures the live one against the resolved droppable's chain (which does
 * not). In a real browser `over` takes a frame or two to resolve, so that
 * switch happens after the capture on EVERY drag, same-track included, which
 * is what the owner hit. Under jsdom, with no real measurement latency, a
 * same-track drag resolves its `over` on the very first initialized render, so
 * its captured offset is already the post-switch one and `event.delta` comes
 * out clean — tests 1-3 therefore pin the landing arithmetic end to end but
 * would pass on the broken code too. **Test 4 is the one that reproduces
 * B-145**: a cross-track drag necessarily changes `over` mid-gesture, so the
 * switch lands after the capture exactly as it does in a browser, and on the
 * pre-fix code it lands the clip at `startFrame: 0` — the owner's own symptom,
 * deterministically, in CI.
 *
 * **Tier limit, stated rather than papered over.** Because the library never
 * fires its own `onScroll` under jsdom, `TimelinePane`'s own `scrollLeft` state
 * stays 0 while the DOM grid is scrolled, so the "content scrolled DURING the
 * drag" term of `dragDelta` is exercised by `dragDelta.test.ts`, not here. The
 * live verification for that, for the same-track case, and for the full range
 * of zooms and scroll offsets is the real-browser tier (`app/harness.html`) —
 * see `docs/notes/timeline-drag-interactions.md`.
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
  nextFrame,
  stubBoundingRectsFromInlineStyle,
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
import type { Timeline } from './timeline';

const FPS = 24;
/** `DEFAULT_PX_PER_SEC` (`ruler.ts`), which `TimelinePane` starts at. */
const PX_PER_SEC = 90;
const ROW_HEIGHT_PX = 52;

/** One 5-second clip parked well away from frame 0, plus a second track to
 *  drag onto. `start_frame: 480` is 20 seconds in — far enough out that a
 *  landing "at the very start" is unmistakable and far outside every snap
 *  radius (`INSERT_SNAP_PX` is 28px ≈ 7 frames at this zoom). */
const CLIP_START = 480;
const CLIP_FRAMES = 120;

function buildFixture(): Timeline {
  const clip = (id: string, start: number) => ({
    id,
    name: `${id}.MOV`,
    source_path: `/${id}.mp4`,
    source_start: 0,
    duration: CLIP_FRAMES,
    source_len: 4800,
    start_frame: start,
  });
  return {
    id: 'clip-drag-fixture-tl',
    name: 'clip drag fixture',
    rate: { num: FPS, den: 1 },
    tracks: [
      // `decoy` exists for one reason: a cross-track move that EMPTIES its
      // source track prunes that track (`pruneIfEmptyTrack`, by the owner's own
      // explicit ask), which renumbers everything below it and would make test
      // 4's "did it land on track 1" assertion read `0` for a move that
      // actually worked. It is parked 100 seconds out, far outside every snap
      // radius and every landing under test, so it changes nothing else.
      { kind: 'video', clips: [clip('a', CLIP_START), clip('decoy', 2400)] },
      { kind: 'video', clips: [] },
    ],
  };
}

let restore: Array<() => void> = [];
let mounted: MountedComponent | null = null;
let console_: ReturnType<typeof captureConsole>;

/** jsdom-tier stub (1): a real horizontal scroll offset on the timeline
 *  library's own scrolling grid — the element dnd-kit walks up to and reads
 *  `scrollLeft` off. Returns a restore function. */
function scrollTimelineGridTo(px: number): () => void {
  // The library renders TWO `ReactVirtualized__Grid`s — one for the ruler/time
  // area and one for the edit area. Only the second is the dragged clip's own
  // scroll container, and stubbing the wrong one is silent: dnd-kit reads a
  // scroll offset of 0 and the whole precondition quietly does not happen.
  const grids = [...mounted!.container.querySelectorAll<HTMLElement>('.ReactVirtualized__Grid')];
  const grid = grids.find((g) => g.contains(clipBody('a')));
  if (!grid) throw new Error('no scrolling grid contains the dragged clip');
  const had = Object.getOwnPropertyDescriptor(grid, 'scrollLeft');
  Object.defineProperty(grid, 'scrollLeft', { value: px, configurable: true });
  return () => {
    if (had) Object.defineProperty(grid, 'scrollLeft', had);
    else Reflect.deleteProperty(grid, 'scrollLeft');
  };
}

/** jsdom-tier stub (2): tie each `TrackDropZone`'s measured box to the box its
 *  own track row really occupies, which is what they are in a browser. Without
 *  it every zone measures 0×0 and no drop ever resolves an `over`. */
function alignDropZonesToRows(): void {
  const rows = [...mounted!.container.querySelectorAll<HTMLElement>('.timeline-editor-edit-row')];
  const zones = [...mounted!.container.querySelectorAll<HTMLElement>('[data-chroma-track-drop-zone]')];
  if (rows.length === 0 || zones.length === 0) throw new Error('no rows or no drop zones rendered');
  for (const zone of zones) {
    const i = Number(zone.dataset.chromaTrackDropZone);
    const row = rows[i];
    if (!row) continue;
    const box = row.getBoundingClientRect();
    zone.getBoundingClientRect = () => box;
  }
}

async function remount() {
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline: buildFixture(),
      openProjectKey: '/projects/clip-drag-fixture.chroma',
      status: 'ready',
      error: null,
      playhead: 0,
      playing: false,
      selection: [],
      selectedGap: null,
    }),
  );
  mounted?.unmount();
  mounted = mount(React.createElement(TimelinePane), { strictMode: true });
  await waitFrames(2);
  alignDropZonesToRows();
}

beforeEach(async () => {
  restore = [
    stubOffsetMetrics(1200, 600),
    installResizeObserverStub(),
    installPointerCaptureStub(),
    stubBoundingRectsFromInlineStyle(),
  ];
  console_ = captureConsole();
  await remount();
});

afterEach(() => {
  const errors = console_.errors;
  console_.restore();
  mounted?.unmount();
  mounted = null;
  for (const r of restore) r();
  restore = [];
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

function clipBody(id: string): HTMLElement {
  const el = mounted!.container.querySelector<HTMLElement>(`[data-chroma-clip-id="${id}"]`);
  if (!el) throw new Error(`the clip ${id} did not render`);
  return el;
}

/** Where clip `id` sits now, and on which track. */
function placed(id: string): { track: number; startFrame: number } {
  const tl = useEditorTimelineStore.getState().timeline;
  if (!tl) throw new Error('no timeline');
  for (let t = 0; t < tl.tracks.length; t++) {
    const c = tl.tracks[t].clips.find((x) => x.id === id);
    if (c) return { track: t, startFrame: c.start_frame };
  }
  throw new Error(`clip ${id} is gone`);
}

/** dnd-kit's `PointerSensor` here has `activationConstraint: {distance: 4}`, so
 *  the press alone starts nothing — the first move past 4px activates the drag
 *  (the same note `TimelinePane.dragGhost.dom.test.tsx` makes). Every move goes
 *  to the owning document, which is where dnd-kit listens. */
const ACTIVATION_NUDGE_PX = 8;

async function dragBy(el: HTMLElement, fromX: number, fromY: number, dx: number, dy = 0) {
  firePointerEvent(el, 'pointerdown', { x: fromX, y: fromY });
  await nextFrame();
  firePointerEvent(document, 'pointermove', { x: fromX + ACTIVATION_NUDGE_PX, y: fromY });
  await nextFrame();
  const steps = 4;
  for (let i = 1; i <= steps; i++) {
    firePointerEvent(document, 'pointermove', { x: fromX + (dx * i) / steps, y: fromY + (dy * i) / steps });
    await nextFrame();
  }
  firePointerEvent(document, 'pointerup', { x: fromX + dx, y: fromY + dy });
  await waitFrames(2);
}

/** Screen px → whole frames, exactly the conversion the pane makes. */
const framesFor = (px: number) => Math.round((px / PX_PER_SEC) * FPS);

// --------------------------------------------------------------------------- //

describe('where a dragged clip lands (B-145)', () => {
  it('1. lands where it was dropped when the timeline is SCROLLED — not at frame 0', async () => {
    // THE regression test. With the library's grid scrolled 2000px in, dnd-kit
    // captures that offset as the drag's "initial" scroll and then measures the
    // live one against a droppable that lives outside the grid, so every
    // `event.delta.x` for the rest of the gesture is short by the full 2000px.
    // At 90px/s that is 533 frames — far more than the clip's own 480-frame
    // position, so `intendedFrame` went negative, `resolveClipLanding` clamped
    // it to 0, and the clip landed at the very start of the timeline no matter
    // where it was actually dropped. That is exactly the owner's report.
    const undo = scrollTimelineGridTo(2000);
    try {
      const el = clipBody('a');
      const box = el.getBoundingClientRect();
      await dragBy(el, box.left + 40, ROW_HEIGHT_PX * 0.5, 180);
      expect(placed('a')).toEqual({ track: 0, startFrame: CLIP_START + framesFor(180) });
    } finally {
      undo();
    }
  });

  it('2. the same drag on an UNSCROLLED timeline lands identically — the scroll must not matter at all', async () => {
    // The case that always worked, kept working, and pinned against the fix
    // over-correcting in the other direction: the landing is a function of how
    // far the pointer moved, full stop.
    const el = clipBody('a');
    const box = el.getBoundingClientRect();
    await dragBy(el, box.left + 40, ROW_HEIGHT_PX * 0.5, 180);
    expect(placed('a')).toEqual({ track: 0, startFrame: CLIP_START + framesFor(180) });
  });

  it('3. dragging LEFT while scrolled moves it earlier by exactly the drag, not to 0', async () => {
    const undo = scrollTimelineGridTo(1500);
    try {
      const el = clipBody('a');
      const box = el.getBoundingClientRect();
      await dragBy(el, box.left + 60, ROW_HEIGHT_PX * 0.5, -270);
      expect(placed('a')).toEqual({ track: 0, startFrame: CLIP_START + framesFor(-270) });
    } finally {
      undo();
    }
  });

  it('4. THE B-145 regression test — a cross-track drag while scrolled keeps its horizontal landing', async () => {
    // On the pre-fix code this lands the clip at `startFrame: 0` no matter
    // where it was dropped, which is the owner's report verbatim ("when i move
    // this instead of moving it moves to very starting"). See this file's own
    // header for why the cross-track gesture is the one that reproduces it in
    // this tier. D-104 is what made cross-track carry horizontal movement at
    // all rather than keeping the clip's original frame, so this also pins that
    // it still does.
    const undo = scrollTimelineGridTo(2000);
    try {
      const el = clipBody('a');
      const box = el.getBoundingClientRect();
      await dragBy(el, box.left + 40, ROW_HEIGHT_PX * 0.5, 120, ROW_HEIGHT_PX);
      expect(placed('a')).toEqual({ track: 1, startFrame: CLIP_START + framesFor(120) });
    } finally {
      undo();
    }
  });
});
