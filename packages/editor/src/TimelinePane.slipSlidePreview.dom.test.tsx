// @vitest-environment jsdom
/**
 * @apelles/editor — real-DOM coverage that a slip/slide drag shows no MOVE
 * preview (B-144), on the same harness and in the same tier as
 * `TimelinePane.dragGhost.dom.test.tsx` (B-137) and `TimelinePane.trim.dom.test.tsx`
 * (D-235/D-261).
 *
 * **What B-144 was.** A slip changes a clip's source window and a slide moves
 * a clip while its neighbours absorb the difference — neither one repositions
 * the dragged clip the way a plain move does (a slide's clip DOES move, but
 * never to wherever the cursor drags it the way a move's landing preview
 * would show; its destination is dictated by its neighbours, not the drop).
 * Despite that, the timeline kept showing the generic MOVE preview — the
 * cursor-follow `DragOverlay` ghost (filmstrip/waveform clone, or its
 * label-pill fallback) — for a slip/slide drag, by BOTH of its entrances:
 * Alt-armed (D-235) and a tool chosen in the palette with no modifier held
 * (D-261, which never got the suppression D-235 already had for Alt).
 *
 * **Why this had to be a DOM test.** Same reasoning as B-137's own file: the
 * ghost is `@dnd-kit/core`'s `DragOverlay`, portaled to `document.body` and
 * driven by component state (`activeDrag`, `trimPressRef`) that only exists
 * once a real drag is really running. Nothing below the component can observe
 * whether the ghost renders — only a real `PointerEvent` drag, sampled
 * mid-gesture, can.
 *
 * **Tier limits, inherited from `TimelinePane.trim.dom.test.tsx` unchanged.**
 * jsdom's `stubBoundingRectsFromInlineStyle` makes the slip-vs-slide vertical
 * band (`SLIP_BAND_RATIO`) a real geometric question here, same as that file.
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
import type { TrimTool } from './trimMode';
import type { Timeline } from './timeline';

const FPS = 24;
const PX_PER_SEC = 90; // DEFAULT_PX_PER_SEC, as `TimelinePane.tsx` defines it
const ROW_HEIGHT_PX = 52; // the library's own rendered action height

// Same fixture shape as `TimelinePane.trim.dom.test.tsx`: three clips butted
// end to end, real source room on both sides, so a slip or a slide has
// somewhere real to go rather than clamping to a no-op.
const CLIP_FRAMES = 48;

function clipFixture(id: string, start: number) {
  return {
    id,
    name: id.toUpperCase(),
    source_path: `/${id}.mp4`,
    source_start: 100,
    duration: CLIP_FRAMES,
    source_len: 480,
    start_frame: start,
  };
}

function buildFixture(): Timeline {
  return {
    id: 'slip-slide-preview-fixture-tl',
    name: 'slip/slide preview fixture',
    rate: { num: FPS, den: 1 },
    tracks: [{ kind: 'video', clips: [clipFixture('a', 0), clipFixture('b', 48), clipFixture('c', 96)] }],
  };
}

let restore: Array<() => void> = [];
let mounted: MountedComponent | null = null;
let console_: ReturnType<typeof captureConsole>;

beforeEach(async () => {
  restore = [
    stubOffsetMetrics(1200, 600),
    installResizeObserverStub(),
    installPointerCaptureStub(),
    stubBoundingRectsFromInlineStyle(),
  ];
  console_ = captureConsole();
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline: buildFixture(),
      openProjectKey: '/projects/slip-slide-preview-fixture.chroma',
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

/** The rendered clip bodies, in track order — index 0 is 'a', 1 is 'b'. */
function bodies(): HTMLElement[] {
  return Array.from(mounted!.container.querySelectorAll('[data-chroma-clip-drag]'));
}

async function pickTool(tool: TrimTool) {
  const btn = mounted!.container.querySelector<HTMLButtonElement>(`[data-chroma-trim-tool="${tool}"]`);
  if (!btn) throw new Error(`no ${tool} tool button`);
  actSync(() => btn.click());
  await nextFrame();
}

/** The B-137 filmstrip/waveform clone — see that file's own `ghostBox`. Its
 *  mere presence (not its geometry) is what B-144 is about. */
function hasFilmstripGhost(): boolean {
  return document.querySelector('[data-chroma-drag-ghost]') !== null;
}

/** The D-098 fallback pill (`TimelinePane.tsx`'s `dragOverlayLabel` branch) —
 *  no stable test hook of its own, so matched on the exact class combination
 *  its markup uses (`rounded-md bg-accent … shadow-lg`), which nothing else in
 *  this pane's DragOverlay renders. */
function hasOverlayPill(): boolean {
  return [...document.querySelectorAll<HTMLElement>('div')].some(
    (el) => el.classList.contains('rounded-md') && el.classList.contains('bg-accent') && el.classList.contains('shadow-lg'),
  );
}

/** dnd-kit's `PointerSensor` here has `activationConstraint: {distance: 4}` —
 *  same note every other file in this tier makes. */
const ACTIVATION_NUDGE_PX = 8;

/** Press, activate, move partway (sampling whether either ghost form is up),
 *  then release. Mirrors `bodyDrag`/`dragAndSample` from the sibling files in
 *  this tier. */
async function dragAndCheckGhost(
  el: HTMLElement,
  fromX: number,
  toX: number,
  y: number,
  opts: Record<string, boolean> = {},
): Promise<{ filmstrip: boolean; pill: boolean }> {
  firePointerEvent(el, 'pointerdown', { x: fromX, y }, opts);
  await nextFrame();
  firePointerEvent(document, 'pointermove', { x: fromX + ACTIVATION_NUDGE_PX, y }, opts);
  await nextFrame();
  const step = (toX - fromX) / 4;
  let mid = { filmstrip: false, pill: false };
  for (let i = 1; i <= 4; i++) {
    firePointerEvent(document, 'pointermove', { x: fromX + step * i, y }, opts);
    await nextFrame();
    if (i === 2) mid = { filmstrip: hasFilmstripGhost(), pill: hasOverlayPill() };
  }
  firePointerEvent(document, 'pointerup', { x: toX, y }, opts);
  await nextFrame();
  return mid;
}

// --------------------------------------------------------------------------- //

describe('a slip/slide drag shows no move preview (B-144)', () => {
  it('0. control — an ordinary unarmed move DOES show the move preview (the fix must not suppress it globally)', async () => {
    const y = ROW_HEIGHT_PX * 0.5;
    const seen = await dragAndCheckGhost(bodies()[1], 200, 290, y);
    expect(seen.filmstrip || seen.pill, 'an ordinary move should show SOME cursor-follow preview').toBe(true);
  });

  it('1. Alt + drag on the UPPER half (slip) shows neither ghost form', async () => {
    const y = ROW_HEIGHT_PX * 0.25; // over the thumbnails: Resolve's own slip zone
    const seen = await dragAndCheckGhost(bodies()[1], 200, 290, y, { altKey: true });
    expect(seen.filmstrip, 'the filmstrip/waveform clone must not render for a slip').toBe(false);
    expect(seen.pill, 'the fallback label pill must not render for a slip either').toBe(false);
  });

  it('2. Alt + drag on the LOWER half (slide) shows neither ghost form', async () => {
    const y = ROW_HEIGHT_PX * 0.75; // under the thumbnails: Resolve's own slide zone
    const seen = await dragAndCheckGhost(bodies()[1], 200, 290, y, { altKey: true });
    expect(seen.filmstrip, 'the filmstrip/waveform clone must not render for a slide').toBe(false);
    expect(seen.pill, 'the fallback label pill must not render for a slide either').toBe(false);
  });

  it('3. the Slip TOOL, with no modifier held, shows neither ghost form — the half B-144 found unfixed', async () => {
    // This is the exact gap the bug named: D-261's tool-driven entrance never
    // got D-235's own suppression, so a tool-chosen slip (no Alt at all) kept
    // painting the move ghost.
    await pickTool('slip');
    const y = ROW_HEIGHT_PX * 0.5; // the tool owns the whole body — band is irrelevant
    const seen = await dragAndCheckGhost(bodies()[1], 200, 290, y);
    expect(seen.filmstrip, 'the filmstrip/waveform clone must not render for a tool-driven slip').toBe(false);
    expect(seen.pill, 'the fallback label pill must not render for a tool-driven slip either').toBe(false);
  });

  it('4. the Slide TOOL, with no modifier held, shows neither ghost form', async () => {
    await pickTool('slide');
    const y = ROW_HEIGHT_PX * 0.5;
    const seen = await dragAndCheckGhost(bodies()[1], 200, 290, y);
    expect(seen.filmstrip, 'the filmstrip/waveform clone must not render for a tool-driven slide').toBe(false);
    expect(seen.pill, 'the fallback label pill must not render for a tool-driven slide either').toBe(false);
  });

  it('5. an edge-only tool (Roll) leaves a body drag as a plain move — the ghost still shows', async () => {
    // Regression guard for the other direction: `trimToolOwns('roll', 'body')`
    // is false (Roll only owns edges), so a body drag under Roll must still be
    // the ordinary move it always was, same as `TimelinePane.dragGhost.dom.test.tsx`
    // test 4 already established for the ghost's geometry.
    await pickTool('roll');
    const y = ROW_HEIGHT_PX * 0.5;
    const seen = await dragAndCheckGhost(bodies()[1], 200, 290, y);
    expect(seen.filmstrip || seen.pill, 'Roll does not own the body zone — this is still a move').toBe(true);
  });
});
