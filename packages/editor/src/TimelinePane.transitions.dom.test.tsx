// @vitest-environment jsdom
/**
 * @chroma/editor — real-DOM regression coverage for the transitions UI (D-224 /
 * D-225), built on `testUtils/pointerHarness.ts` (D-142) and modelled on
 * `TimelinePane.markers.dom.test.tsx`.
 *
 * **Why this file exists.** `timeline.test.ts` is exhaustive at the pure-op
 * level (the derived window, every `checkTransition` refusal, all three ops),
 * and the two pixel suites prove the blend really renders. Neither can prove
 * the two things that make this a feature rather than a data structure: that a
 * transition is drawn at the RIGHT PIXELS for its own window — using the same
 * `pxPerSec`/`scrollLeft` math the ruler, the playhead and every other overlay
 * use, not a second derivation — and that its popover writes the REAL
 * `Track.transitions` field through the REAL store rather than moving pictures
 * around in local state. Those are exactly the failure modes an overlay over an
 * existing model invites.
 *
 * **Tier and its honest limits.** jsdom, not real Chromium — the same
 * disclosure the sibling `.dom.test.tsx` files make, for the same reason (no
 * layout engine; `stubOffsetMetrics` fakes one viewport). It does NOT prove the
 * palette's `@dnd-kit` DRAG: dnd-kit measures real droppable rects, which jsdom
 * does not produce, and the drop's own target resolution is `nearestCut`, unit-
 * tested here directly instead. Every gesture below targets an element, which
 * is what the wiring itself owns; geometry is asserted as a value.
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

import { useEditorTimelineStore } from './timelineStore';
import { TimelinePane } from './TimelinePane';
import { nearestCut, TRANSITION_SNAP_PX } from './TimelineTransitions';
import { transitionWindow, type Timeline, type Transition } from './timeline';

const FPS = 24;
const PX_PER_SEC = 90; // DEFAULT_PX_PER_SEC, as `TimelinePane.tsx` defines it
const START_LEFT_PX = 20; // ditto

/** Two abutting 48-frame clips cut at frame 48, each trimmed inside its own
 *  144-frame source so a cross dissolve has real handle media — the same
 *  fixture shape the model and pixel suites use. */
function buildFixture(transitions: Transition[]): Timeline {
  const clip = (id: string, start: number) => ({
    id,
    name: id,
    source_path: `/${id}.mp4`,
    source_start: 48,
    duration: 48,
    source_len: 144,
    start_frame: start,
  });
  return {
    id: 'transition-fixture-tl',
    name: 'transition fixture',
    rate: { num: FPS, den: 1 },
    tracks: [{ kind: 'video', clips: [clip('A', 0), clip('B', 48)], transitions }],
  };
}

function fixtureTransition(over: Partial<Transition> = {}): Transition {
  return { id: 'tr1', kind: 'cross_dissolve', at_frame: 48, duration: 24, alignment: 'center_at_cut', ...over };
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
      openProjectKey: '/projects/transition-fixture.chroma',
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

function badges(): HTMLElement[] {
  return Array.from(document.querySelectorAll('[data-chroma-transition]'));
}

function badgeFor(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-chroma-transition="${id}"]`);
  if (!el) {
    throw new Error(
      `no transition badge for "${id}" (have: ${badges().map((b) => b.dataset.chromaTransition).join(', ')})`,
    );
  }
  return el;
}

/** The store's live transition list for track 0 — the real field. */
function transitions(): Transition[] {
  return useEditorTimelineStore.getState().timeline?.tracks[0]?.transitions ?? [];
}

function fireClick(target: EventTarget): void {
  actSync(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  });
}

describe('transitions — real DOM (D-224/D-225)', () => {
  it('1. draws one badge per transition, spanning its own DERIVED window at the ruler’s own pixel math', async () => {
    await mountWith(buildFixture([fixtureTransition()]));
    const all = badges();
    expect(all).toHaveLength(1);

    // The window is derived, not stored — a centred 24-frame transition at the
    // frame-48 cut covers [36, 60). Asserting the PIXELS against that, rather
    // than against `at_frame`, is what catches a badge drawn from the cut
    // instead of from the window (which would look plausible and be wrong by
    // half the duration).
    const { start, end } = transitionWindow(fixtureTransition());
    expect({ start, end }).toEqual({ start: 36, end: 60 });
    const badge = badgeFor('tr1');
    expect(badge.style.left).toBe(`${START_LEFT_PX + (start / FPS) * PX_PER_SEC}px`);
    expect(badge.style.width).toBe(`${((end - start) / FPS) * PX_PER_SEC}px`);
  });

  it('2. an "End at Cut" transition draws entirely BEFORE the cut — the alignment is real, not decoration', async () => {
    await mountWith(buildFixture([fixtureTransition({ alignment: 'end_at_cut' })]));
    const badge = badgeFor('tr1');
    // window [24, 48): its right edge lands exactly on the cut.
    expect(badge.style.left).toBe(`${START_LEFT_PX + (24 / FPS) * PX_PER_SEC}px`);
    const rightEdgePx = parseFloat(badge.style.left) + parseFloat(badge.style.width);
    expect(rightEdgePx).toBeCloseTo(START_LEFT_PX + (48 / FPS) * PX_PER_SEC, 6);
  });

  it('3. the badge’s popover REMOVES the real transition from the store, and leaves both clips untouched', async () => {
    await mountWith(buildFixture([fixtureTransition()]));
    const clipsBefore = useEditorTimelineStore.getState().timeline?.tracks[0].clips;
    fireClick(badgeFor('tr1'));
    await waitFrames(2);

    const remove = Array.from(document.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Remove transition'),
    );
    expect(remove, 'the badge popover must offer a Remove').toBeTruthy();
    fireClick(remove!);
    await waitFrames(2);

    expect(transitions()).toEqual([]);
    // A transition never moved either clip to make room, so removing it must
    // not move them back — the whole point of D-224's bridging model.
    expect(useEditorTimelineStore.getState().timeline?.tracks[0].clips).toEqual(clipsBefore);
  });

  it('4. the popover reads the transition’s REAL duration, and its dip swatch writes a real set_transition', async () => {
    // The write path is asserted through the colour SWATCH (a plain `<button>`),
    // not the duration field — the same choice `TimelinePane.markers.dom.test
    // .tsx` made for the same reason: the text/number fields are Base UI
    // primitives whose value plumbing jsdom cannot drive faithfully, and the
    // point of this assertion is the popover → `applyOp` → store wiring, which
    // one real committed field proves as well as another. The duration's own
    // clamping and refusal rules are covered exhaustively as pure ops in
    // `timeline.test.ts` (`set_transition` re-validates the MERGED shape).
    await mountWith(buildFixture([fixtureTransition({ kind: 'dip_to_color' })]));
    fireClick(badgeFor('tr1'));
    await waitFrames(2);

    const field = Array.from(document.querySelectorAll('input')).find((i) => i.value === '24');
    expect(field, 'the popover must show the transition’s real duration').toBeTruthy();

    const swatch = Array.from(document.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'red',
    );
    expect(swatch, 'a dip must offer its colour palette').toBeTruthy();
    fireClick(swatch!);
    await waitFrames(2);

    expect(transitions()[0]?.color).toBe('#D9434E'); // the shared palette's own red
    expect(transitions()[0]?.duration).toBe(24); // a patch, so nothing else moved
  });

  it('5. a timeline with no transitions draws no badges at all', async () => {
    await mountWith(buildFixture([]));
    expect(badges()).toHaveLength(0);
  });

  it('6. the toolbar carries the Transitions palette', async () => {
    await mountWith(buildFixture([]));
    const trigger = Array.from(document.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'Transitions',
    );
    expect(trigger, 'the timeline toolbar must offer a Transitions palette').toBeTruthy();
  });

  it('7. nearestCut — the drop target resolution the palette drag uses', () => {
    // Not a DOM assertion: dnd-kit's drag needs real measured rects jsdom does
    // not produce (see this file's own header), so the part of the gesture that
    // actually DECIDES anything is asserted directly instead.
    const snap = Math.round((TRANSITION_SNAP_PX / PX_PER_SEC) * FPS);
    expect(nearestCut([48], 48, snap)).toBe(48);
    expect(nearestCut([48], 48 + snap, snap)).toBe(48);
    expect(nearestCut([48], 48 + snap + 1, snap)).toBeNull(); // a near-miss is REFUSED, not snapped
    expect(nearestCut([], 48, snap)).toBeNull();
    expect(nearestCut([10, 48], 46, snap)).toBe(48); // the nearest, not the first
    expect(nearestCut([10, 48], 30, snap)).toBeNull(); // between two, near neither
  });
});
