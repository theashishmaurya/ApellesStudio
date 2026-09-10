// @vitest-environment jsdom
/**
 * @apelles/editor — real-DOM coverage for the clip-drag ghost's position
 * (B-137 / D-278), on the same harness and in the same tier as
 * `TimelinePane.trim.dom.test.tsx` and `TimelinePane.trimTools.dom.test.tsx`.
 *
 * **What this file proves, and why it had to be a DOM test.** B-137 was
 * reported from one static screenshot as "the trim drag's preview stays pinned
 * at the clip's original position." The pure layer cannot answer it: the ghost's
 * on-screen position is `@dnd-kit/core`'s, written by `PositionedOverlay` as
 * `left: activeNodeRect.left` plus a live transform, and the defect only exists
 * in the relationship between that anchor, the ghost's own capped width and
 * where in the clip the pointer actually pressed. So every assertion here reads
 * the ghost's REAL live geometry mid-drag — after the moves, before the release
 * — which is the thing the screenshot showed and nothing else could.
 *
 * **What it found, stated plainly, because it is not what the bug entry
 * guessed.** The trim tool is not involved. The gesture in the screenshot was a
 * clip-BODY drag (a `@dnd-kit/core` drag, whose ghost is the only thing on this
 * surface that is capped at `MAX_DRAG_GHOST_PX` wide), not the timeline
 * library's interact.js edge resize, and the same detached ghost appears with
 * the plain Select tool. Test 4 pins that down so the "it is the Trim tool"
 * reading cannot come back.
 *
 * **Tier limits, inherited unchanged** from the two files above: jsdom, so
 * `stubOffsetMetrics` fakes one viewport and `stubBoundingRectsFromInlineStyle`
 * derives each clip's box from the inline `left`/`width`/`height` the timeline
 * library really writes — which is exactly the rect dnd-kit measures, so the
 * ghost geometry under test here is real rather than a stand-in. The library's
 * own interact.js EDGE resize still cannot be driven in this tier (re-verified
 * by probe during this pass, unchanged since D-235), which is a limit on what
 * this file covers, not on what it concluded — see B-137.
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
import { MAX_DRAG_GHOST_PX } from './dragGhost';
import type { TrimTool } from './trimMode';
import type { Timeline } from './timeline';

const FPS = 24;
/** `DEFAULT_PX_PER_SEC`, as `ruler.ts` defines it and `TimelinePane` starts at. */
const PX_PER_SEC = 90;
/** `START_LEFT_PX`, as `TimelinePane.tsx` defines it — the edit area's own left
 *  inset, which is where frame 0 sits and therefore where a clip at frame 0 is
 *  laid out. */
const START_LEFT_PX = 32;
const ROW_HEIGHT_PX = 52;

/** 20 seconds — 1800px at the default zoom, five and a half times the ghost
 *  cap. Deliberately an ordinary length for real footage rather than a
 *  contrived extreme: at 90px/s the cap is reached by EVERY clip longer than
 *  ~3.5s, which is why B-137 fired on the owner's very first drag. */
const LONG_FRAMES = 480;
/** 2 seconds — 180px, comfortably inside the cap. The case that always looked
 *  right, and that must keep looking exactly as it did. */
const SHORT_FRAMES = 48;

function buildFixture(durationFrames: number): Timeline {
  return {
    id: 'ghost-fixture-tl',
    name: 'ghost fixture',
    rate: { num: FPS, den: 1 },
    tracks: [
      {
        kind: 'video',
        clips: [
          {
            id: 'a',
            name: 'A001.MOV',
            source_path: '/a.mp4',
            source_start: 0,
            duration: durationFrames,
            source_len: 4800,
            start_frame: 0,
          },
        ],
      },
    ],
  };
}

let restore: Array<() => void> = [];
let mounted: MountedComponent | null = null;
let console_: ReturnType<typeof captureConsole>;

async function remountWith(durationFrames: number) {
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline: buildFixture(durationFrames),
      openProjectKey: '/projects/ghost-fixture.chroma',
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
}

beforeEach(async () => {
  restore = [
    stubOffsetMetrics(1200, 600),
    installResizeObserverStub(),
    installPointerCaptureStub(),
    stubBoundingRectsFromInlineStyle(),
  ];
  console_ = captureConsole();
  await remountWith(LONG_FRAMES);
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

function body(): HTMLElement {
  const el = mounted!.container.querySelector<HTMLElement>('[data-chroma-clip-drag]');
  if (!el) throw new Error('the clip body did not render');
  return el;
}

/** The ghost's REAL on-screen box, mid-drag: `DragOverlay` positions its
 *  wrapper with `left`/`top` and a `transform`, so both have to be read to know
 *  where the thing actually is — reading only one is how a test can "pass"
 *  against a ghost sitting off in the corner. `null` when no ghost is up. */
function ghostBox(): { left: number; width: number } | null {
  const inner = document.querySelector<HTMLElement>('[data-chroma-drag-ghost]');
  const wrapper = inner?.parentElement;
  if (!inner || !wrapper) return null;
  const left = Number.parseFloat(wrapper.style.left || '0');
  const width = Number.parseFloat(inner.style.width || '0');
  const tx = /translate3d\((-?[\d.]+)px/.exec(wrapper.style.transform ?? '');
  return { left: left + (tx ? Number.parseFloat(tx[1]) : 0), width };
}

async function pickTool(tool: TrimTool) {
  const btn = mounted!.container.querySelector<HTMLButtonElement>(`[data-chroma-trim-tool="${tool}"]`);
  if (!btn) throw new Error(`no ${tool} tool button`);
  actSync(() => btn.click());
  await nextFrame();
}

/** dnd-kit's `PointerSensor` here has `activationConstraint: {distance: 4}`, so
 *  a press alone starts nothing: the first move past 4px is what activates the
 *  drag, and the overlay's very first commit renders before that move's own
 *  translate has been stored (established by probe on the real component — its
 *  transform is one move behind for exactly one frame, dnd-kit's own behaviour,
 *  not this pane's). Every sample below is therefore taken AFTER a separate
 *  activation move, so what is asserted is steady-state tracking rather than
 *  the one-commit mount lag. */
const ACTIVATION_NUDGE_PX = 8;

/** Press at `fromX`, activate, then move through `path`, handing back the
 *  ghost's live box at every step WITHOUT releasing — the mid-drag state a
 *  screenshot captures and a commit-only assertion can never see. Releases at
 *  the end so the component is left idle.
 *
 *  dnd-kit listens on the owning document (this pane's own marquee/fade
 *  listeners are the ones on `window`), per the D-235 file's own probe, so the
 *  moves go there. */
async function dragAndSample(
  el: HTMLElement,
  fromX: number,
  path: number[],
  y: number,
  opts: Record<string, boolean> = {},
): Promise<Array<{ x: number; ghost: { left: number; width: number } | null }>> {
  firePointerEvent(el, 'pointerdown', { x: fromX, y }, opts);
  await nextFrame();
  firePointerEvent(document, 'pointermove', { x: fromX + ACTIVATION_NUDGE_PX, y }, opts);
  await nextFrame();
  const samples: Array<{ x: number; ghost: { left: number; width: number } | null }> = [];
  for (const x of path) {
    firePointerEvent(document, 'pointermove', { x, y }, opts);
    await nextFrame();
    samples.push({ x, ghost: ghostBox() });
  }
  firePointerEvent(document, 'pointerup', { x: path[path.length - 1] ?? fromX, y }, opts);
  await nextFrame();
  return samples;
}

// --------------------------------------------------------------------------- //

describe('the clip-drag ghost stays with the pointer (B-137)', () => {
  it('1. a long clip grabbed far along keeps its ghost under the pointer for the whole drag', async () => {
    // THE regression test. The clip is 1800px wide and the press lands 1100px
    // into it — the ordinary case of grabbing a 20-second clip somewhere in
    // the middle. Before the fix the ghost was a `MAX_DRAG_GHOST_PX`-wide stub
    // anchored at the clip's LEFT EDGE, i.e. roughly 800px to the left of the
    // pointer and never getting any closer, which is exactly what the owner
    // screenshotted and read as "pinned at the clip's original position."
    const pressX = START_LEFT_PX + 1100;
    const samples = await dragAndSample(body(), pressX, [pressX + 40, pressX + 120, pressX - 60], ROW_HEIGHT_PX * 0.5);

    expect(samples).toHaveLength(3);
    for (const { x, ghost } of samples) {
      expect(ghost, `no ghost at x=${x}`).not.toBeNull();
      expect(ghost!.width, 'the ghost is still capped — this fix does not widen it').toBeLessThanOrEqual(
        MAX_DRAG_GHOST_PX,
      );
      // The whole point, stated as the thing the screenshot disproved: the
      // pointer is INSIDE the ghost.
      expect(x, `ghost left edge at x=${x}`).toBeGreaterThanOrEqual(ghost!.left);
      expect(x, `ghost right edge at x=${x}`).toBeLessThanOrEqual(ghost!.left + ghost!.width);
    }
  });

  it('2. the ghost tracks the pointer 1:1 — it moves exactly as far as the drag does', async () => {
    // "Under the pointer" on its own could be satisfied by a ghost that
    // happened to be wide enough to cover a stationary error. This pins the
    // motion itself: the ghost's displacement equals the pointer's, which is
    // what "follows the cursor" actually means.
    const pressX = START_LEFT_PX + 900;
    const samples = await dragAndSample(body(), pressX, [pressX + 50, pressX + 200], ROW_HEIGHT_PX * 0.5);
    const [first, second] = samples;
    expect(second.ghost!.left - first.ghost!.left).toBeCloseTo(second.x - first.x, 5);
  });

  it('3. a SHORT clip is untouched — its ghost still sits exactly on the clip it came from', async () => {
    // The behaviour that always looked right, kept exactly as it was: a clip
    // narrower than the cap has no window to slice, so the ghost is the whole
    // clip, anchored on it. A fix that "worked" by moving this one too would
    // have broken the case D-119 shipped for.
    await remountWith(SHORT_FRAMES);
    const clipLeft = START_LEFT_PX;
    const clipWidth = (SHORT_FRAMES / FPS) * PX_PER_SEC;
    const pressX = clipLeft + 40;
    const samples = await dragAndSample(body(), pressX, [pressX + 60], ROW_HEIGHT_PX * 0.5);

    const ghost = samples[0].ghost!;
    expect(ghost.width).toBe(clipWidth);
    // Anchored at the clip's own left edge plus the drag's delta, with no
    // window offset of any kind added on top.
    expect(ghost.left).toBeCloseTo(clipLeft + (samples[0].x - pressX), 5);
  });

  it('4. the Trim tool is not involved — the same drag detaches, and is fixed, with Select and with Roll alike', async () => {
    // B-137 was filed against the Trim tool because that is what the owner had
    // active. It is not the cause: an edge-only tool (Roll) leaves a body drag
    // as the plain dnd-kit move it has always been (D-261, and that file's own
    // test 8), so both tools reach this same ghost. Asserting both is what
    // stops the wrong reading from being re-derived later.
    const pressX = START_LEFT_PX + 1400;
    const y = ROW_HEIGHT_PX * 0.5;

    const withSelect = await dragAndSample(body(), pressX, [pressX + 80], y);
    await remountWith(LONG_FRAMES);
    await pickTool('roll');
    const withRoll = await dragAndSample(body(), pressX, [pressX + 80], y);

    for (const [label, samples] of [
      ['select', withSelect],
      ['roll', withRoll],
    ] as const) {
      const { x, ghost } = samples[0];
      expect(ghost, `${label}: no ghost`).not.toBeNull();
      expect(x, `${label}: pointer left of the ghost`).toBeGreaterThanOrEqual(ghost!.left);
      expect(x, `${label}: pointer right of the ghost`).toBeLessThanOrEqual(ghost!.left + ghost!.width);
    }
    expect(withRoll[0].ghost).toEqual(withSelect[0].ghost);
  });

  it('5. the ghost is a WINDOW centred on the grab point, and clamped at the clip’s ends', async () => {
    // The other half of the fix, asserted through the one thing this tier can
    // measure exactly: WHERE IN THE GHOST the pointer sits. A window centred
    // on the grab point puts the pointer at the ghost's midpoint; a window
    // clamped at the clip's tail puts it proportionally further right; a grab
    // near the head leaves the ghost anchored at the head with the pointer
    // wherever it pressed. Those three numbers, together, pin the window's
    // start to the pixel — and since the ghost's picture content is derived
    // from that same start (`dragGhost.test.ts` covers the arithmetic), a
    // ghost showing the wrong part of the clip cannot pass this.
    const clipWidth = (LONG_FRAMES / FPS) * PX_PER_SEC; // 1800
    const half = MAX_DRAG_GHOST_PX / 2;
    const cases: Array<[label: string, grabPx: number, expectedInsidePx: number]> = [
      // Mid-clip: centred, so dead centre of the ghost.
      ['middle', 1100, half],
      // Near the tail: the window cannot start past `clipWidth - width`, so it
      // clamps and the pointer sits right of centre instead of running off.
      ['tail', 1750, 1750 - (clipWidth - MAX_DRAG_GHOST_PX)],
      // Near the head: clamped the other way — the ghost is the clip's head,
      // exactly as it always was, and the pointer is where it pressed.
      ['head', 50, 50],
    ];

    for (const [label, grabPx, expectedInsidePx] of cases) {
      await remountWith(LONG_FRAMES);
      const pressX = START_LEFT_PX + grabPx;
      const samples = await dragAndSample(body(), pressX, [pressX + 70], ROW_HEIGHT_PX * 0.5);
      const { x, ghost } = samples[0];
      expect(ghost, `${label}: no ghost`).not.toBeNull();
      expect(x - ghost!.left, `${label}: where the pointer sits inside the ghost`).toBeCloseTo(expectedInsidePx, 5);
    }
  });
});
